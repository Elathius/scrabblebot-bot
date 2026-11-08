// ScrabbleBot bot client.
//
// First run, with a token from the website:
//   `BOT_NAME=<name> BOT_TOKEN=<token> npm start`
// Or with a nonce from the CLI:
//   `spacetime call scrabblebot mint_credential_nonce`
//   `spacetime sql scrabblebot 'SELECT code FROM my_nonces'`
//   `BOT_NAME=<name> BOT_NONCE=<code> npm start`
// The token is saved to .token-<BOT_NAME> (git-ignored); later runs need
// only `BOT_NAME=<name> npm start`. Add `TOURNAMENT_ID=<id>` to register.
//
// Design: subscribe ONLY to this bot's own rows and the matches it is in.
// Subscribing to every table streams every match on the server through
// this client, which delays reducer replies by seconds and makes every bid
// arrive after the auction has closed.

import {
  DbConnection,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { Dictionary, WordEngine, chooseWords, decideBid } from "./strategy.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_NONCE = process.env.BOT_NONCE;
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

// Do not send a bid when less than this remains before the auction closes;
// it would be rejected anyway.
const BID_DEADLINE_MARGIN_MS = Number(process.env.BID_MARGIN_MS ?? 150);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

const dictionaryPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "wordlist.txt",
);
const DICT = new Dictionary(
  fs.existsSync(dictionaryPath)
    ? fs.readFileSync(dictionaryPath, "utf8").split("\n")
    : [],
);
const ENGINE = new WordEngine(DICT);
console.log(`[${BOT_NAME}] dictionary loaded: ${DICT.entries.length} words`);

type Sub = { unsubscribe(): void };

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
let registered = false;
let lastLobbyAttempt = 0;
const bidsByAuction = new Set<string>();
const inflightByMatch = new Map<string, number>();
const INFLIGHT_TIMEOUT_MS = 2500;
const matchSubs = new Map<string, Sub[]>();
const paidByMatch = new Map<string, number[]>();
const bootstrapped = new Set<string>();

function log(msg: string) {
  console.log(`[${BOT_NAME}] ${msg}`);
}
function logFailure(what: string) {
  return (err: unknown) =>
    console.warn(
      `[${BOT_NAME}] ${what} failed: ${err instanceof Error ? err.message : err}`,
    );
}

// ---------------------------------------------------------------------------
// State readers (all local cache, no network)

function rackForMatch(conn: DbConnection, matchId: bigint): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    if (h.count > 0) rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

function participants(conn: DbConnection, matchId: bigint) {
  const mine = { balance: 0, score: 0, found: false };
  const others: { balance: number; score: number }[] = [];
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId === myBotId) {
      mine.balance = Number(p.balance);
      mine.score = Number(p.score);
      mine.found = true;
    } else others.push({ balance: Number(p.balance), score: Number(p.score) });
  }
  return { mine, others, count: others.length + (mine.found ? 1 : 0) };
}

function marketPrice(matchId: bigint): number | undefined {
  const xs = paidByMatch.get(String(matchId));
  if (!xs || xs.length < 3) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function myRunningMatches(conn: DbConnection): bigint[] {
  const out: bigint[] = [];
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = conn.db.matchState.id.find(p.matchId);
    if (m?.status.tag === "Running") out.push(p.matchId);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Actions

function tryBid(conn: DbConnection, a: { id: bigint; matchId: bigint; letter: string; closesAt: { toDate(): Date }; status: { tag: string } }) {
  if (myBotId === null) return;
  if (a.status.tag !== "Open") return;
  const key = `${a.matchId}:${a.id}`;
  if (bidsByAuction.has(key)) return;
  const m = conn.db.matchState.id.find(a.matchId);
  if (!m || m.status.tag !== "Running") return;
  const { mine, others, count } = participants(conn, a.matchId);
  if (!mine.found) return;

  const remaining = a.closesAt.toDate().getTime() - Date.now();
  if (remaining < BID_DEADLINE_MARGIN_MS) {
    bidsByAuction.add(key);
    log(`skip '${a.letter}': only ${remaining}ms left (auction ${a.id})`);
    return;
  }

  const t0 = performance.now();
  const amount = decideBid({
    letter: a.letter,
    myBalance: mine.balance,
    myRack: rackForMatch(conn, a.matchId),
    bagTotal: Number(m.bagTotal),
    auctionType: m.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey",
    numBots: count,
    marketPrice: marketPrice(a.matchId),
    myScore: mine.score,
    opponents: others,
    engine: ENGINE,
  });
  const ms = (performance.now() - t0).toFixed(0);
  bidsByAuction.add(key);
  if (amount <= 0) {
    log(`pass on '${a.letter}' (bag ${m.bagTotal}, bal ${mine.balance}, ${ms}ms)`);
    return;
  }
  conn.reducers
    .submitBid({ auctionId: a.id, amount: BigInt(amount) })
    .catch(logFailure(`bid ${amount} on '${a.letter}' (auction ${a.id})`));
  log(
    `bid ${amount} on '${a.letter}' (match ${a.matchId}, bag ${m.bagTotal}, bal ${mine.balance}, mkt ${marketPrice(a.matchId) ?? "?"}, ${ms}ms, ${remaining}ms left)`,
  );
}

function tryPlayWord(conn: DbConnection) {
  if (myBotId === null) return;
  const now = Date.now();
  for (const matchId of myRunningMatches(conn)) {
    const m = conn.db.matchState.id.find(matchId);
    if (!m) continue;
    const key = String(matchId);
    const inflight = inflightByMatch.get(key);
    if (inflight !== undefined && now - inflight < INFLIGHT_TIMEOUT_MS) continue;
    const { mine, count } = participants(conn, matchId);
    const rack = rackForMatch(conn, matchId);
    const t0 = performance.now();
    const decision = chooseWords({
      myRack: rack,
      bagTotal: Number(m.bagTotal),
      myBalance: mine.balance,
      numBots: count,
      engine: ENGINE,
    });
    const word = decision.words[0];
    if (!word) continue;
    inflightByMatch.set(key, now);
    log(
      `match ${matchId}: playing '${word}' (${decision.reason}; plan ${decision.words.join("+")}=${decision.total}; rack ${[...rack].map(([l, n]) => l.repeat(n)).join("")}; ${(performance.now() - t0).toFixed(0)}ms)`,
    );
    conn.reducers
      .submitWord({ matchId, word })
      .then(() => {
        inflightByMatch.delete(key);
        setTimeout(() => tryPlayWord(conn), 30);
      })
      .catch((err: unknown) => {
        inflightByMatch.delete(key);
        logFailure(`playing '${word}'`)(err);
        setTimeout(() => tryPlayWord(conn), 500);
      });
  }
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
  if (myRunningMatches(conn).length > 0) return;
  const now = Date.now();
  if (now - lastLobbyAttempt < 8000) return;
  const openLobby = Array.from(conn.db.openLobbies.iter()).find(
    (l) => l.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.openLobbyMembers.iter()).some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId,
    );
  if (alreadyIn) return;
  lastLobbyAttempt = now;
  log("joining lobby");
  conn.reducers.joinLobby({}).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    // Expected while a tournament we're in is running.
    log(`lobby join refused: ${msg}`);
  });
}

// ---------------------------------------------------------------------------
// Subscriptions

function subscribeMatch(conn: DbConnection, matchId: bigint) {
  const key = String(matchId);
  if (matchSubs.has(key)) return;
  const subs: Sub[] = [];
  const q = [
    `SELECT * FROM match_state WHERE id = ${matchId}`,
    `SELECT * FROM match_participant WHERE match_id = ${matchId}`,
    `SELECT * FROM auction WHERE match_id = ${matchId}`,
    `SELECT * FROM auction_result WHERE match_id = ${matchId}`,
  ];
  subs.push(
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        const m = conn.db.matchState.id.find(matchId);
        log(`match ${matchId} subscribed (status ${m?.status.tag ?? "?"}, bag ${m?.bagTotal ?? "?"})`);
        if (m?.status.tag === "Running") {
          for (const a of conn.db.auction.iter()) {
            if (a.matchId === matchId && a.status.tag === "Open") tryBid(conn, a);
          }
          tryPlayWord(conn);
        } else if (m?.status.tag === "Ended") {
          scheduleUnsubscribe(conn, matchId);
        }
      })
      .onError((ctx: ErrorContext) => {
        console.error(`[${BOT_NAME}] match ${matchId} subscription error:`, ctx.event?.message ?? ctx.event);
      })
      .subscribe(q),
  );
  matchSubs.set(key, subs);
}

function scheduleUnsubscribe(conn: DbConnection, matchId: bigint) {
  const key = String(matchId);
  const subs = matchSubs.get(key);
  if (!subs) return;
  setTimeout(() => {
    for (const s of subs) {
      try {
        s.unsubscribe();
      } catch {
        /* already gone */
      }
    }
    matchSubs.delete(key);
    paidByMatch.delete(key);
  }, 5000);
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  log(`connected as ${identity.toHexString()}`);

  // Table callbacks. Registered once; they fire for any subscription.
  conn.db.auction.onInsert((_ctx, a) => tryBid(conn, a));
  conn.db.auction.onUpdate((_ctx, _old, a) => tryBid(conn, a));
  conn.db.myRack.onInsert(() => tryPlayWord(conn));
  conn.db.myRack.onUpdate(() => tryPlayWord(conn));
  conn.db.myRack.onDelete(() => tryPlayWord(conn));
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (r.winnerBotId !== undefined && r.winnerBotId !== null && Number(r.paid) > 0) {
      const k = String(r.matchId);
      const xs = paidByMatch.get(k) ?? [];
      xs.push(Number(r.paid));
      paidByMatch.set(k, xs);
    }
    if (r.winnerBotId === myBotId) log(`won '${r.letter}' for ${r.paid} (match ${r.matchId})`);
  });
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (old.bagTotal !== neu.bagTotal && neu.status.tag === "Running") tryPlayWord(conn);
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const { mine } = participants(conn, neu.id);
      if (mine.found) {
        log(`match ${neu.id} ended: score ${mine.score}, cash ${mine.balance}; rejoining lobby`);
        scheduleUnsubscribe(conn, neu.id);
        lastLobbyAttempt = 0;
        setTimeout(() => joinLobby(conn), 500);
      }
    }
  });
  conn.db.matchParticipant.onInsert((_ctx, p) => {
    if (p.botId === myBotId) {
      log(`seated in match ${p.matchId}`);
      subscribeMatch(conn, p.matchId);
    }
  });
  conn.db.matchParticipant.onUpdate((_ctx, old, neu) => {
    if (neu.botId === myBotId && old.balance !== neu.balance) tryPlayWord(conn);
  });
  conn.db.botCredential.onInsert((_ctx, c) => {
    if (myBotId === null && myIdentity && c.identity.isEqual(myIdentity)) {
      myBotId = c.botId;
      log(`claimed credential for bot id ${myBotId}`);
      afterBotKnown(conn);
    }
  });

  const hex = identity.toHexString().replace(/^0x/, "");
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      log("base subscription applied");
      const cred = conn.db.botCredential.identity.find(identity);
      if (cred) {
        myBotId = cred.botId;
        afterBotKnown(conn);
        return;
      }
      if (BOT_NONCE) {
        log("claiming credential with nonce…");
        conn.reducers
          .claimCredential({ code: BOT_NONCE })
          .catch((err: unknown) => {
            logFailure("claiming the credential")(err);
            process.exit(1);
          });
        // botCredential.onInsert completes the handshake.
        setTimeout(() => {
          if (myBotId === null) {
            console.error(`[${BOT_NAME}] credential never arrived; re-run with BOT_NAME only (token saved) or a fresh nonce.`);
            process.exit(1);
          }
        }, 15000);
        return;
      }
      console.error(`[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`);
      process.exit(1);
    })
    .onError((ctx: ErrorContext) => {
      console.error(`[${BOT_NAME}] base subscription error:`, ctx.event?.message ?? ctx.event);
    })
    .subscribe([
      `SELECT * FROM bot_credential WHERE identity = 0x${hex}`,
      `SELECT * FROM my_rack`,
      `SELECT * FROM open_lobbies`,
      `SELECT * FROM open_lobby_members`,
      `SELECT * FROM tournament`,
    ]);
}

function afterBotKnown(conn: DbConnection) {
  if (myBotId === null) return;
  const key = String(myBotId);
  if (bootstrapped.has(key)) return;
  bootstrapped.add(key);
  log(`acting as bot id ${myBotId}`);
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      log("bot subscription applied");
      // Subscribe to every match we have a seat in; ended ones drop off.
      for (const p of conn.db.matchParticipant.iter()) {
        if (p.botId === myBotId) subscribeMatch(conn, p.matchId);
      }
      bootstrapActivity(conn);
    })
    .onError((ctx: ErrorContext) => {
      console.error(`[${BOT_NAME}] bot subscription error:`, ctx.event?.message ?? ctx.event);
    })
    .subscribe([
      `SELECT * FROM bot WHERE id = ${myBotId}`,
      `SELECT * FROM match_participant WHERE bot_id = ${myBotId}`,
      `SELECT * FROM tournament_entry WHERE bot_id = ${myBotId}`,
    ]);
}

function bootstrapActivity(conn: DbConnection) {
  const bot = myBotId !== null ? conn.db.bot.id.find(myBotId) : undefined;
  log(`ready as '${bot?.name ?? "?"}' (id ${myBotId})`);
  if (TOURNAMENT_ID && !registered) {
    registered = true;
    const tid = BigInt(TOURNAMENT_ID);
    const already = Array.from(conn.db.tournamentEntry.iter()).some(
      (e) => e.tournamentId === tid && e.botId === myBotId,
    );
    if (already) log(`already registered for tournament ${TOURNAMENT_ID}`);
    else
      conn.reducers
        .registerForTournament({ tournamentId: tid })
        .then(() => log(`registered for tournament ${TOURNAMENT_ID}`))
        .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  joinLobby(conn);
  setInterval(() => {
    joinLobby(conn);
    for (const a of conn.db.auction.iter()) if (a.status.tag === "Open") tryBid(conn, a);
    tryPlayWord(conn);
  }, 1000);
}

function main() {
  log(`connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) => {
      console.error("connect error:", err.message);
      setTimeout(main, 3000);
    })
    .onDisconnect(() => {
      log("disconnected; reconnecting in 2s");
      myBotId = null;
      bootstrapped.clear();
      matchSubs.clear();
      setTimeout(main, 2000);
    })
    .build();
}

main();
