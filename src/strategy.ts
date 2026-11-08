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

  // Best reward among words at most `d` tiles short of the rack, length >= minLen.
  private withinMemo = new Map<string, number>();
  bestWithin(rack: Uint8Array, d: number, minLen: number): number {
    const mk = rackKey(rack) + "|" + d + "|" + minLen;
    const hit = this.withinMemo.get(mk);
    if (hit !== undefined) return hit;
    const r = this.bestWithinUncached(rack, d, minLen);
    if (this.withinMemo.size > 100000) this.withinMemo.clear();
    this.withinMemo.set(mk, r);
    return r;
  }
  private bestWithinUncached(rack: Uint8Array, d: number, minLen: number): number {
    let best = 0;
    let tiles = 0;
    for (let i = 0; i < 26; i++) tiles += rack[i];
    const maxL = Math.min(tiles + d, this.dict.maxLen);
    for (let L = maxL; L >= minLen; L--) {
      const bucket = this.dict.byLength[L];
      if (!bucket) continue;
      for (const e of bucket) {
        if (e.reward <= best) break;
        if (deficit(e, rack, d) <= d) {
          best = e.reward;
          break;
        }
      }
    }
    return best;
  }

  // Precompute everything a bid on any letter would need for this rack, so
  // the bid itself is a few map lookups. Runs in small chunks off the event
  // loop so it never delays an incoming auction.
  warm(rack: Uint8Array, horizon: number, onDone?: () => void) {
    this.value(rack, horizon);
    let i = 0;
    const step = () => {
      const end = Math.min(26, i + 3);
      for (; i < end; i++) {
        const r = new Uint8Array(rack);
        r[i]++;
        this.value(r, horizon);
      }
      if (i < 26) setImmediate(step);
      else onDone?.();
    };
    setImmediate(step);
  }

  // Heuristic rack value: realizable now plus discounted near-completions.
  value(rack: Uint8Array, horizon: number): number {
    const now = this.best(rack).total;
    if (horizon <= 0) return now;
    // Seven-letter words pay 3x, so the rack's upside is the best 7+ word
    // it is close to, discounted by how many tiles are still missing and
    // how many auctions remain to find them. Take the max, not the sum, so
    // overlapping targets are not double counted.
    const w = [
      0,
      Math.min(0.6, 0.1 * horizon),
      Math.min(0.35, 0.05 * horizon),
      Math.min(0.18, 0.025 * horizon),
    ];
    let up = 0;
    for (let d = 1; d <= 3; d++) {
      const r = this.bestWithin(rack, d, 7);
      up = Math.max(up, w[d] * Math.max(0, r - now));
    }
    // Medium words one tile away are a solid fallback.
    const r5 = this.bestWithin(rack, 1, 5);
    up = Math.max(up, Math.min(0.5, 0.08 * horizon) * Math.max(0, r5 - now));
    return now + up;
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
const RATE_DIV = Number(process.env.RATE_DIV ?? 3.5);
const RATE_CAP = Number(process.env.RATE_CAP ?? 3.5);
const VALUE_TILT = Number(process.env.VALUE_TILT ?? 0);

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
  const market = ctx.marketPrice && ctx.marketPrice > 0 ? ctx.marketPrice : 10;

  // Coins per expected point. Cash is worthless at the end, so the rate
  // rises when we are sitting on more cash than the remaining auctions can
  // absorb, and falls as the bankroll thins out.
  const rate = Math.max(0.8, Math.min(RATE_CAP, spendPerTile / RATE_DIV));

  let bid = delta * rate;

  // Letter-value prior. Reward is linear in letter value and a 7+ word pays
  // 3x, so a letter's expected contribution is 3 * value * P(it ends up in
  // a long word). Heavy letters are harder to place but pay far more; the
  // near-word search alone misses them until a word is almost complete,
  // which is exactly how a bot ends up with a rack of 1-point tiles.
  const lv = LETTER_VALUE[letter] ?? 1;
  let heavyHeld = 0;
  for (let i = 0; i < 26; i++) if ((LETTER_VALUE[String.fromCharCode(A + i)] ?? 0) >= 4) heavyHeld += rack[i];
  let pUse = lv >= 8 ? 0.3 : lv >= 4 ? 0.5 : lv >= 2 ? 0.55 : 0.6;
  if (letter === "Q") pUse = rack["U".charCodeAt(0) - A] > 0 ? 0.35 : 0.1;
  pUse *= Math.min(1, horizon / 15);
  if (heavyHeld >= 3) pUse *= 0.5;
  if (rack[li] >= 1 && lv >= 4) pUse *= 0.5;
  if (tiles >= 10) pUse *= 0.3;
  const prior = 3 * lv * pUse;
  bid = Math.max(bid, prior * rate);

  // Early rack building: a small rack has little measurable upside yet,
  // but needs tiles. Keep buying at a paced rate, preferring balance.
  const isVowel = VOWELS.includes(letter);
  if (tiles < 7 && horizon > 10) {
    let floor = spendPerTile * 0.8;
    if (isVowel ? vowels >= tiles * 0.5 + 1 : consonants >= tiles * 0.7 + 1) floor *= 0.5;
    if (rack[li] >= 2) floor *= 0.4;
    bid = Math.max(bid, floor);
  } else if (delta > 0) {
    bid = Math.max(bid, spendPerTile * 0.5);
  } else if (horizon > 2 && tiles < 9 && rack[li] < 2 && spendPerTile > 8) {
    // Cash is piling up relative to what is left to buy: keep acquiring
    // usable letters so it gets converted before the end.
    bid = Math.max(bid, spendPerTile * (HEAVY.includes(letter) ? 0.3 : 0.6));
  }
  if (rack[li] >= 3) bid *= 0.3;
  if (tiles >= 11 && delta <= 0) bid = 0;
  if (tiles >= 14) bid = 0;
  // Late game: cash is losing its value fast, lean in on real gains.
  if (horizon <= 6 && delta > 0) bid = Math.max(bid, delta * 2 + spendPerTile);
  if (horizon <= 2 && delta > 0) bid = Math.max(bid, balance * 0.8);
  void market;

  // Reward is linear in letter value and 7-letter words pay 3x, so a
  // 4-point letter in a long word is worth four 1-point letters. Tilt bids
  // toward valuable letters; Q is capped because it needs a U.

  if (ctx.auctionType === "FirstPrice") bid *= 0.7;

  // Cheap pickups: unbid tiles vanish, so a reserve-price bid is free value.
  if (bid < 1 && tiles < 9 && !(rack[li] >= 3)) bid = 1;

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
