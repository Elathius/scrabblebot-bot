// Offline arena: replays the server's auction/word rules against a mix of
// opponent policies so bidding constants can be tuned on many games.
// Run: npx tsx sim/sim.ts [games]
//
// Rules mirrored from the official module (commit b5ccb36): 98-tile bag, 5
// hidden starting tiles each, one tile drawn per auction, Vickrey payment
// (second price, reserve 1), random tie-break, unbid tiles consumed, the
// final tile cannot be played, reward = floor(sum * multiplier).

import * as fs from "node:fs";
import {
  Dictionary,
  WordEngine,
  decideBid,
  chooseWords,
  rackToCounts,
  LETTER_VALUE,
  BAG_COUNTS,
  reward,
} from "../src/strategy.js";

const dict = new Dictionary(fs.readFileSync(new URL("../wordlist.txt", import.meta.url), "utf8").split("\n"));
const engine = new WordEngine(dict);

type Rack = Map<string, number>;
interface Bot {
  name: string;
  rack: Rack;
  balance: number;
  score: number;
  bid(letter: string, bagTotal: number, numBots: number, paid: number[]): number;
  play(bagTotal: number, numBots: number): string | null;
}

function add(r: Rack, l: string, n = 1) { r.set(l, (r.get(l) ?? 0) + n); }
function remove(r: Rack, w: string) { for (const c of w) { const n = (r.get(c) ?? 0) - 1; if (n <= 0) r.delete(c); else r.set(c, n); } }
function tiles(r: Rack) { let t = 0; for (const n of r.values()) t += n; return t; }
function canSpell(w: string, r: Rack) { const u: Record<string, number> = {}; for (const c of w) { u[c] = (u[c] ?? 0) + 1; if (u[c] > (r.get(c) ?? 0)) return false; } return true; }

// Longest-first greedy (the starter's chooseWord).
const byLenDesc = [...dict.words].sort((a, b) => b.length - a.length);
function greedyLongest(r: Rack): string | null {
  const t = tiles(r);
  for (const w of byLenDesc) if (w.length <= t && canSpell(w, r)) return w;
  return null;
}
function median(xs: number[]) { if (xs.length < 3) return undefined; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

function mkOurs(name: string): Bot {
  const b: Bot = {
    name, rack: new Map(), balance: 100, score: 0,
    bid(letter, bagTotal, numBots, paid) {
      return decideBid({ letter, myBalance: b.balance, myRack: b.rack, bagTotal, auctionType: "Vickrey", numBots, marketPrice: median(paid), engine });
    },
    play(bagTotal, numBots) {
      return chooseWords({ myRack: b.rack, bagTotal, myBalance: b.balance, numBots, engine }).words[0] ?? null;
    },
  };
  return b;
}
// Server sim strategies: base + jitter in [-2, 2]; words: longest greedy.
function mkSim(name: string, kind: "Cheapskate" | "ValueBidder" | "Aggressive"): Bot {
  const b: Bot = {
    name, rack: new Map(), balance: 100, score: 0,
    bid(letter) {
      const v = LETTER_VALUE[letter] ?? 1;
      const vowel = "AEIOU".includes(letter);
      const base = kind === "Cheapskate" ? v - 1 : kind === "ValueBidder" ? v : v + (vowel ? 4 : 2);
      const jitter = Math.floor(Math.random() * 5) - 2;
      return Math.max(0, Math.min(b.balance, Math.max(1, base + jitter)));
    },
    play() { return greedyLongest(b.rack); },
  };
  return b;
}
// The official starter: face value (+2 if not held), longest word greedy.
function mkStarter(name: string): Bot {
  const b: Bot = {
    name, rack: new Map(), balance: 100, score: 0,
    bid(letter) { const v = LETTER_VALUE[letter] ?? 1; const want = (b.rack.get(letter) ?? 0) === 0 ? v + 2 : Math.max(1, v); return Math.min(want, b.balance); },
    play() { return greedyLongest(b.rack); },
  };
  return b;
}
// A plausible one-prompt "AI" bot: spends evenly, holds for 5+ letter words,
// liquidates at the end.
function mkAiStarter(name: string, aggression: number): Bot {
  const b: Bot = {
    name, rack: new Map(), balance: 100, score: 0,
    bid(letter, bagTotal, numBots) {
      const t = tiles(b.rack);
      if (t >= 10) return 0;
      const per = b.balance / Math.max(1, bagTotal / numBots);
      const v = LETTER_VALUE[letter] ?? 1;
      const have = b.rack.get(letter) ?? 0;
      let bid = per * aggression + v * 0.5 - have * 2;
      if (bagTotal <= 1) bid = b.balance;
      return Math.max(0, Math.min(b.balance, Math.floor(bid)));
    },
    play(bagTotal) {
      const w = greedyLongest(b.rack);
      if (!w) return null;
      if (bagTotal <= 3) return w;
      if (w.length >= 5) return w;
      if (tiles(b.rack) >= 9) return w;
      return null;
    },
  };
  return b;
}

function playGame(bots: Bot[], seed: number) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const bag: string[] = [];
  for (const [l, n] of Object.entries(BAG_COUNTS)) for (let i = 0; i < n; i++) bag.push(l);
  for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
  for (const b of bots) { b.rack = new Map(); b.balance = 100; b.score = 0; for (let i = 0; i < 5; i++) add(b.rack, bag.pop()!); }
  const paid: number[] = [];
  const n = bots.length;
  while (bag.length > 0) {
    const letter = bag.pop()!;
    const bagTotal = bag.length; // excludes the offered tile
    // Word plays happen between auctions (each bot may play several).
    for (const b of bots) {
      for (let k = 0; k < 4; k++) {
        const w = b.play(bagTotal, n);
        if (!w || !canSpell(w, b.rack) || !dict.words.has(w)) break;
        remove(b.rack, w); const r = reward(w); b.score += r; b.balance += r;
      }
    }
    const bids = bots.map((b, i) => ({ i, amt: Math.max(0, Math.min(b.balance, Math.floor(b.bid(letter, bagTotal, n, paid)))) }));
    const pos = bids.filter((x) => x.amt > 0);
    if (pos.length === 0) continue;
    for (let i = pos.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pos[i], pos[j]] = [pos[j], pos[i]]; }
    pos.sort((a, b) => b.amt - a.amt);
    const winner = pos[0];
    const price = pos.length > 1 ? Math.max(1, pos[1].amt) : 1;
    bots[winner.i].balance -= price;
    paid.push(price);
    if (bagTotal === 0) break; // final tile: match ends in the same transaction
    add(bots[winner.i].rack, letter);
  }
  return bots.map((b) => ({ name: b.name, score: b.score, cash: b.balance, left: tiles(b.rack) }));
}

const games = Number(process.argv[2] ?? 40);
const tables: (() => Bot[])[] = [
  () => [mkOurs("ours"), mkSim("agg1", "Aggressive"), mkSim("agg2", "Aggressive"), mkSim("val", "ValueBidder"), mkStarter("starter"), mkAiStarter("ai1", 1.0)],
  () => [mkOurs("ours"), mkAiStarter("ai1", 1.0), mkAiStarter("ai2", 1.3), mkAiStarter("ai3", 0.8), mkSim("agg", "Aggressive"), mkStarter("starter")],
  () => [mkOurs("ours"), mkOurs("ours2"), mkAiStarter("ai1", 1.2), mkAiStarter("ai2", 1.0), mkSim("agg", "Aggressive"), mkSim("val", "ValueBidder")],
];
const stats = new Map<string, { games: number; score: number; places: number[]; cash: number; left: number }>();
for (let g = 0; g < games; g++) {
  const bots = tables[g % tables.length]();
  const res = playGame(bots, 1000 + g);
  const ranked = [...res].sort((a, b) => b.score - a.score);
  for (const r of res) {
    const st = stats.get(r.name) ?? { games: 0, score: 0, places: [0, 0, 0, 0, 0, 0], cash: 0, left: 0 };
    st.games++; st.score += r.score; st.cash += r.cash; st.left += r.left;
    st.places[ranked.findIndex((x) => x.name === r.name)]++;
    stats.set(r.name, st);
  }
}
console.log("name      games  avgScore  avgCashLeft  avgTilesLeft  places(1st..6th)");
for (const [name, st] of [...stats].sort((a, b) => b[1].score / b[1].games - a[1].score / a[1].games)) {
  console.log(`${name.padEnd(9)} ${String(st.games).padStart(5)}  ${(st.score / st.games).toFixed(1).padStart(8)}  ${(st.cash / st.games).toFixed(1).padStart(11)}  ${(st.left / st.games).toFixed(1).padStart(12)}  ${st.places.join(" ")}`);
}
