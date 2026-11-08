// ScrabbleBot strategy: exact multiword rack conversion, marginal-value
// tile bidding, horizon-aware play/hold, and endgame liquidation.
//
// Game facts this relies on (verified against the official server source,
// commit b5ccb36):
//   reward(word) = floor(sum(letterValue) * mult(len)),
//   mult: len<=3 -> 1.0, 4 -> 1.5, 5 -> 2.0, 6 -> 2.5, 7+ -> 3.0.
//   The tile offered when bagTotal == 0 is the last one; the match ends in
//   the same transaction that settles it, so it can never be played.
//   Vickrey auction by default (winner pays second price, or 1 if alone).

export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

export const BAG_COUNTS: Record<string, number> = {
  A: 9, B: 2, C: 2, D: 4, E: 12, F: 2, G: 3, H: 2, I: 9, J: 1, K: 1, L: 4,
  M: 2, N: 6, O: 8, P: 2, Q: 1, R: 6, S: 4, T: 6, U: 4, V: 2, W: 2, X: 1,
  Y: 2, Z: 1,
};

export function reward(word: string): number {
  let base = 0;
  for (const c of word) base += LETTER_VALUE[c] ?? 0;
  const n = word.length;
  if (n <= 3) return base;
  if (n === 4) return Math.floor((base * 3) / 2);
  if (n === 5) return base * 2;
  if (n === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

// ---------------------------------------------------------------------------
// Dictionary preprocessing

export interface Entry {
  word: string;
  counts: Uint8Array; // 26 letter counts
  reward: number;
  len: number;
}

const A = 65;

export function toCounts(word: string): Uint8Array {
  const c = new Uint8Array(26);
  for (let i = 0; i < word.length; i++) c[word.charCodeAt(i) - A]++;
  return c;
}

export function rackToCounts(rack: Map<string, number>): Uint8Array {
  const c = new Uint8Array(26);
  for (const [l, n] of rack) {
    const i = l.charCodeAt(0) - A;
    if (i >= 0 && i < 26) c[i] += n;
  }
  return c;
}

export class Dictionary {
  entries: Entry[] = [];
  byLength: Entry[][] = [];
  maxLen = 0;
  words = new Set<string>();

  constructor(words: Iterable<string>, maxLen = 15) {
    for (const raw of words) {
      const w = raw.trim().toUpperCase();
      if (w.length < 2 || w.length > maxLen || !/^[A-Z]+$/.test(w)) continue;
      const counts = toCounts(w);
      // Impossible with the physical bag (no blanks) -> drop.
      let feasible = true;
      for (let i = 0; i < 26; i++) {
        if (counts[i] > (BAG_COUNTS[String.fromCharCode(A + i)] ?? 0)) {
          feasible = false;
          break;
        }
      }
      if (!feasible) continue;
      const e: Entry = { word: w, counts, reward: reward(w), len: w.length };
      this.entries.push(e);
      this.words.add(w);
      (this.byLength[w.length] ??= []).push(e);
      if (w.length > this.maxLen) this.maxLen = w.length;
    }
    // Highest reward first inside each length bucket.
    for (const bucket of this.byLength) bucket?.sort((a, b) => b.reward - a.reward);
    this.entries.sort((a, b) => b.reward - a.reward);
  }
}

function fits(e: Entry, rack: Uint8Array): boolean {
  const c = e.counts;
  for (let i = 0; i < 26; i++) if (c[i] > rack[i]) return false;
  return true;
}

// Number of tiles `e` needs that `rack` lacks.
function deficit(e: Entry, rack: Uint8Array, cap: number): number {
  let d = 0;
  const c = e.counts;
  for (let i = 0; i < 26; i++) {
    if (c[i] > rack[i]) {
      d += c[i] - rack[i];
      if (d > cap) return d;
    }
  }
  return d;
}

function rackKey(rack: Uint8Array): string {
  let s = "";
  for (let i = 0; i < 26; i++) if (rack[i]) s += String.fromCharCode(A + i) + rack[i];
  return s;
}

// ---------------------------------------------------------------------------
// Word engine

export interface Plan {
  words: string[];
  total: number;
}

const EMPTY: Plan = { words: [], total: 0 };

export class WordEngine {
  private memo = new Map<string, Plan>();
  private nodes = 0;
  constructor(public dict: Dictionary, private maxNodes = 40000, private branch = 14) {}

  playable(rack: Uint8Array): Entry[] {
    let tiles = 0;
    for (let i = 0; i < 26; i++) tiles += rack[i];
    const out: Entry[] = [];
    const maxL = Math.min(tiles, this.dict.maxLen);
    for (let L = maxL; L >= 2; L--) {
      const bucket = this.dict.byLength[L];
      if (!bucket) continue;
      for (const e of bucket) if (fits(e, rack)) out.push(e);
    }
    return out;
  }

  // Best total reward obtainable by playing a set of words from `rack`.
  // Exact when the node budget is not exhausted; otherwise best-so-far.
  best(rack: Uint8Array): Plan {
    this.nodes = 0;
    const cands = this.playable(rack);
    return this.solve(rack, cands);
  }

  private solve(rack: Uint8Array, cands: Entry[]): Plan {
    const key = rackKey(rack);
    const hit = this.memo.get(key);
    if (hit) return hit;
    if (cands.length === 0) return EMPTY;
    this.nodes++;
    let bestPlan: Plan = EMPTY;
    // Candidates are sorted by reward desc within length buckets; take the
    // top few by reward overall to bound branching.
    const ordered = cands.slice().sort((a, b) => b.reward - a.reward);
    const limit = this.nodes > this.maxNodes ? 1 : this.branch;
    const seen = new Set<string>();
    let tried = 0;
    for (const e of ordered) {
      if (tried >= limit) break;
      // Skip anagram duplicates: same counts -> same subproblem.
      const ck = rackKey(e.counts);
      if (seen.has(ck)) continue;
      seen.add(ck);
      tried++;
      const rest = new Uint8Array(rack);
      for (let i = 0; i < 26; i++) rest[i] -= e.counts[i];
      const sub = cands.filter((x) => x !== e && fits(x, rest));
      const tail = this.solve(rest, sub);
      const total = e.reward + tail.total;
      if (total > bestPlan.total) bestPlan = { words: [e.word, ...tail.words], total };
    }
    if (this.memo.size > 200000) this.memo.clear();
    this.memo.set(key, bestPlan);
    return bestPlan;
  }

  // Best reward among words that are exactly `d` tiles short of the rack,
  // restricted to length >= minLen. Used for setup value of a tile.
  bestNear(rack: Uint8Array, d: number, minLen: number): number {
    let best = 0;
    let tiles = 0;
    for (let i = 0; i < 26; i++) tiles += rack[i];
    const maxL = Math.min(tiles + d, this.dict.maxLen);
    for (let L = maxL; L >= minLen; L--) {
      const bucket = this.dict.byLength[L];
      if (!bucket) continue;
      for (const e of bucket) {
        if (e.reward <= best) break; // bucket sorted by reward desc
        if (deficit(e, rack, d) === d) {
          best = e.reward;
          break;
        }
      }
    }
    return best;
  }

  // Heuristic rack value: realizable now plus discounted near-completions.
  value(rack: Uint8Array, horizon: number): number {
    const now = this.best(rack).total;
    if (horizon <= 0) return now;
    // Chance of completing a one-away word shrinks as the horizon shrinks.
    const w1 = Math.min(0.5, 0.08 * horizon);
    const w2 = Math.min(0.22, 0.03 * horizon);
    const near1 = this.bestNear(rack, 1, 5);
    const near2 = horizon >= 5 ? this.bestNear(rack, 2, 7) : 0;
    return now + w1 * Math.max(0, near1 - now) + w2 * Math.max(0, near2 - now);
  }
}

// ---------------------------------------------------------------------------
// Decisions

export interface BidContext {
  letter: string;
  myBalance: number;
  myRack: Map<string, number>;
  bagTotal: number; // tiles still undrawn (excludes the offered tile)
  auctionType: "Vickrey" | "FirstPrice";
  numBots: number; // participants in this match
  marketPrice?: number; // median price paid so far in this match
  myScore?: number;
  opponents?: { balance: number; score: number }[];
  engine: WordEngine;
}

const VOWELS = "AEIOU";
const HEAVY = "QZJXKVW";

/**
 * Economics: cash has no value at the end of the match, only score does.
 * So the goal is to convert the whole bankroll into tiles that become long
 * words. We size bids so that winning our fair share of the remaining
 * usable auctions spends everything, then tilt each bid by how much this
 * letter helps the rack. Vickrey means we pay the runner-up's bid, so
 * bidding our true value costs little when we are the only one who wants it.
 */
export function decideBid(ctx: BidContext): number {
  const balance = Math.max(0, Math.floor(ctx.myBalance));
  if (balance <= 0) return 0;
  // Final auction: the tile can never be played. Never pay for it.
  if (ctx.bagTotal <= 0) return 0;

  const letter = ctx.letter.toUpperCase();
  const li = letter.charCodeAt(0) - A;
  if (li < 0 || li >= 26) return 0;

  const rack = rackToCounts(ctx.myRack);
  let tiles = 0;
  let vowels = 0;
  for (let i = 0; i < 26; i++) {
    tiles += rack[i];
    if (VOWELS.includes(String.fromCharCode(A + i))) vowels += rack[i];
  }
  const consonants = tiles - vowels;

  // Usable auctions including this one; horizon = those after this one.
  const usable = ctx.bagTotal;
  const horizon = usable - 1;
  const numBots = Math.max(2, ctx.numBots || 6);

  const withTile = new Uint8Array(rack);
  withTile[li]++;
  const delta = ctx.engine.value(withTile, horizon) - ctx.engine.value(rack, horizon);

  // Last usable tile: cash is worthless afterwards. Pay anything for gain.
  if (horizon === 0) return delta > 0 ? balance : 0;

  // Fair share of what is left, and what we can afford per expected win.
  const fairShare = Math.max(1, usable / numBots);
  const spendPerTile = balance / fairShare;
  const market = ctx.marketPrice && ctx.marketPrice > 0 ? ctx.marketPrice : 9;

  // Letter quality relative to our rack.
  let q = 1.0;
  q += delta / 10;
  const isVowel = VOWELS.includes(letter);
  if (isVowel) {
    if (vowels < tiles * 0.35) q += 0.3;
    else if (vowels >= tiles * 0.5 + 1) q -= 0.4;
  } else {
    if (consonants < tiles * 0.5) q += 0.25;
    else if (consonants >= tiles * 0.7 + 1) q -= 0.3;
  }
  if (rack[li] >= 2 && delta <= 0) q -= 0.35;
  if (HEAVY.includes(letter) && delta <= 0) q -= 0.35;
  if (tiles >= 10 && delta <= 0) q *= 0.4;
  if (tiles >= 13 && delta <= 0) q = 0;
  q = Math.max(0, Math.min(3, q));

  let bid = spendPerTile * q;
  // A letter that improves the rack is worth at least the going rate.
  if (delta > 0) bid = Math.max(bid, market * 0.9 + delta * 0.5);
  // Late game: cash is losing its value fast, lean in on real gains.
  if (horizon <= 6 && delta > 0) bid = Math.max(bid, delta * 2 + spendPerTile);
  if (horizon <= 2 && delta > 0) bid = Math.max(bid, balance * 0.8);

  if (ctx.auctionType === "FirstPrice") bid *= 0.7;

  // Cheap pickups: unbid tiles vanish, so a reserve-price bid is free value.
  if (bid < 1 && q > 0 && tiles < 9) bid = 1;

  return Math.max(0, Math.min(balance, Math.floor(bid)));
}

export interface WordContext {
  myRack: Map<string, number>;
  bagTotal: number;
  myBalance: number;
  numBots?: number;
  engine: WordEngine;
}

export interface WordDecision {
  words: string[]; // ordered words to submit, best first
  total: number;
  reason: string;
}

/**
 * Decide which words (if any) to play now. Returns an empty list to hold.
 * Seven-letter words pay 3x and dominate scoring, so the rack is built
 * toward them; shorter words are played when they are strong, when cash is
 * needed to keep buying, when the rack is crowded, or when time is short.
 */
export function chooseWords(ctx: WordContext): WordDecision {
  const rack = rackToCounts(ctx.myRack);
  let tiles = 0;
  for (let i = 0; i < 26; i++) tiles += rack[i];
  if (tiles < 2) return { words: [], total: 0, reason: "no tiles" };

  const plan = ctx.engine.best(rack);
  if (plan.words.length === 0) return { words: [], total: 0, reason: "nothing playable" };

  const horizon = Math.max(0, ctx.bagTotal - 1);
  const numBots = Math.max(2, ctx.numBots ?? 6);

  // Endgame: liquidate everything while there is still time to be confirmed.
  if (horizon <= 4) return { ...plan, reason: "endgame liquidation" };

  const bestWord = plan.words[0];
  const bestLen = bestWord.length;
  const bestReward = reward(bestWord);

  if (bestLen >= 7) return { words: [bestWord], total: plan.total, reason: "7+ word" };

  // Can one more tile make a 7+? Then keep building unless we must cash in.
  const near7 = ctx.engine.bestNear(rack, 1, 7);
  const near7b = ctx.engine.bestNear(rack, 2, 7);
  const spendPerTile = ctx.myBalance / Math.max(1, ctx.bagTotal / numBots);
  const cashStarved = ctx.myBalance < 12 || spendPerTile < 5;
  const crowded = tiles >= 10;

  if (!cashStarved && !crowded && horizon >= 8) {
    if (near7 > bestReward * 1.1) return { words: [], total: 0, reason: `hold: 1 from ${near7}` };
    if (near7b > bestReward * 1.6 && tiles <= 8)
      return { words: [], total: 0, reason: `hold: 2 from ${near7b}` };
  }

  // Strong 5-6 letter word with no 7 in sight: take it.
  if (bestLen >= 5 && bestReward >= 16)
    return { words: [bestWord], total: plan.total, reason: "strong 5-6 word" };

  if (crowded) return { words: [bestWord], total: plan.total, reason: "crowded" };
  if (cashStarved && bestReward >= 6)
    return { words: [bestWord], total: plan.total, reason: "cash flow" };
  if (horizon <= 12 && tiles >= 7)
    return { words: [bestWord], total: plan.total, reason: "late convert" };
  if (bestLen >= 5 && tiles >= 9)
    return { words: [bestWord], total: plan.total, reason: "convert" };

  return { words: [], total: 0, reason: "building" };
}

// Back-compat helper for the starter test: longest playable word.
export function chooseWord(ctx: { myRack: Map<string, number>; dictionary: string[] }): string | null {
  let tiles = 0;
  for (const n of ctx.myRack.values()) tiles += n;
  for (const word of ctx.dictionary) {
    if (word.length <= tiles && canSpell(word, ctx.myRack)) return word;
  }
  return null;
}

export function canSpell(word: string, rack: Map<string, number>): boolean {
  const used: Record<string, number> = {};
  for (const c of word) {
    used[c] = (used[c] ?? 0) + 1;
    if (used[c] > (rack.get(c) ?? 0)) return false;
  }
  return true;
}
