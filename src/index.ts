// ScrabbleBot bot starter.
//
// First run, with a token from the website:
//   On your team's page, click "Generate token", then run
//   `BOT_NAME=<name> BOT_TOKEN=<token> npm start`.
//
// Or with a nonce from the CLI:
//   1. `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. `BOT_NAME=<name> BOT_NONCE=<code> npm start`
//      The bot connects fresh and redeems the nonce.
//
// Either way the bot saves its token to .token-<BOT_NAME>, so later runs
// need only `BOT_NAME=<name> npm start`.
//
// Entering a tournament: `BOT_NAME=<name> TOURNAMENT_ID=<id> npm start`
// registers the bot for that tournament when it connects. Only the bot
// itself can register, so this has to come from the bot's process.
//
// Edit ./src/strategy.ts to customise how your bot bids and plays words.

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { Dictionary, WordEngine, chooseWords, decideBid } from "./strategy.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

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

// Load the wordlist (copied from the official spacetimedb/wordlist.txt) and
// preprocess it once into the word engine.
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

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidsByAuction = new Set<string>();
// One word submission in flight per match; cleared on rack change,
// failure, or timeout.
const inflightByMatch = new Map<string, number>();
const INFLIGHT_TIMEOUT_MS = 2500;
const RETRY_MS = 400;
const bidTimers = new Map<string, ReturnType<typeof setTimeout>>();

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function rackForMatch(
  conn: DbConnection,
  matchId: bigint,
): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  if (myBotId === null) return null;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId !== myBotId) continue;
    return { balance: Number(p.balance), score: Number(p.score) };
  }
  return null;
}

// A reducer call fails when the module refuses it, often for an expected
// reason: a word played just after its match ended, a bid that missed the
// auction's window. Log it and keep playing; an uncaught failure would stop
// the bot.
function logFailure(what: string) {
  return (err: unknown) =>
    console.warn(
      `[${BOT_NAME}] ${what} failed: ${err instanceof Error ? err.message : err}`,
    );
}

function tryBid(
  conn: DbConnection,
  auctionId: bigint,
  matchId: bigint,
  letter: string,
) {
  if (myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  if (bidsByAuction.has(key)) return;
  const participant = participantForMatch(conn, matchId);
  if (!participant) return;
  const m = conn.db.matchState.id.find(matchId);
  if (!m || m.status.tag !== "Running") return;
  const opponents: { balance: number; score: number }[] = [];
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId || p.botId === myBotId) continue;
    opponents.push({ balance: Number(p.balance), score: Number(p.score) });
  }
  const t0 = performance.now();
  const amount = decideBid({
    letter,
    myBalance: participant.balance,
    myRack: rackForMatch(conn, matchId),
    bagTotal: Number(m.bagTotal),
    auctionType: m.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey",
    myScore: participant.score,
    opponents,
    engine: ENGINE,
  });
  bidsByAuction.add(key);
  const ms = (performance.now() - t0).toFixed(0);
  if (amount <= 0) {
    console.log(`[${BOT_NAME}] pass on '${letter}' (bag ${m.bagTotal}, ${ms}ms)`);
    return;
  }
  conn.reducers
    .submitBid({ auctionId, amount: BigInt(amount) })
    .catch((err: unknown) => {
      bidsByAuction.delete(key);
      logFailure(`bid on auction ${auctionId}`)(err);
    });
  console.log(
    `[${BOT_NAME}] bid ${amount} on '${letter}' (match ${matchId}, auction ${auctionId}, bag ${m.bagTotal}, ${ms}ms)`,
  );
}

function tryPlayWord(conn: DbConnection) {
  if (myBotId === null) return;
  const now = Date.now();
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const matchId = p.matchId;
    const m = conn.db.matchState.id.find(matchId);
    if (m?.status.tag !== "Running") continue;
    const key = String(matchId);
    const inflight = inflightByMatch.get(key);
    if (inflight !== undefined && now - inflight < INFLIGHT_TIMEOUT_MS) continue;
    const rack = rackForMatch(conn, matchId);
    const t0 = performance.now();
    const decision = chooseWords({
      myRack: rack,
      bagTotal: Number(m.bagTotal),
      myBalance: Number(p.balance),
      engine: ENGINE,
    });
    const word = decision.words[0];
    if (!word) continue;
    inflightByMatch.set(key, now);
    console.log(
      `[${BOT_NAME}] match ${matchId}: playing '${word}' (${decision.reason}, plan ${decision.words.join("+")} = ${decision.total}, ${(performance.now() - t0).toFixed(0)}ms)`,
    );
    conn.reducers
      .submitWord({ matchId, word })
      .then(() => {
        inflightByMatch.delete(key);
        // Rack rows update asynchronously; re-plan shortly in case more
        // words are ready (multiword plans, endgame liquidation).
        setTimeout(() => tryPlayWord(conn), 50);
      })
      .catch((err: unknown) => {
        inflightByMatch.delete(key);
        logFailure(`playing '${word}'`)(err);
        setTimeout(() => tryPlayWord(conn), RETRY_MS);
      });
  }
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);

      // Resolve our bot id, possibly after claiming a nonce.
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers
            .claimCredential({ code: BOT_NONCE })
            .catch(logFailure("claiming the credential"));
          // Wait briefly for the credential to land; check again.
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(
                `[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`,
              );
              process.exit(1);
            }
            const bot = conn.db.bot.id.find(myBotId);
            console.log(
              `[${BOT_NAME}] claimed credential for bot '${bot?.name ?? "?"}' (id ${myBotId})`,
            );
            bootstrapActivity(conn);
          }, 1000);
          return;
        } else {
          console.error(
            `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`,
          );
          process.exit(1);
        }
      }

      const bot = conn.db.bot.id.find(myBotId);
      console.log(
        `[${BOT_NAME}] acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`,
      );
      bootstrapActivity(conn);
    })
    .subscribeToAllTables();

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  });
  conn.db.myRack.onInsert(() => tryPlayWord(conn));
  conn.db.myRack.onUpdate(() => tryPlayWord(conn));
  conn.db.myRack.onDelete(() => tryPlayWord(conn));
  // Re-plan on match progression too: the endgame decision depends on
  // bagTotal, not only on the rack.
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (old.bagTotal !== neu.bagTotal && neu.status.tag === "Running") {
      tryPlayWord(conn);
    }
  });
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (myBotId === null) return;
    const winner =
      r.winnerBotId !== undefined && r.winnerBotId !== null
        ? String(r.winnerBotId)
        : "no-bid";
    console.log(
      `[${BOT_NAME}] match ${r.matchId} auction ${r.auctionId} '${r.letter}' → bot ${winner} paid ${r.paid}`,
    );
  });

  // When a match this bot was in ends, hop back into the lobby.
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = Array.from(conn.db.matchParticipant.iter()).some(
        (p) => p.matchId === neu.id && p.botId === myBotId,
      );
      if (wasIn) {
        console.log(`[${BOT_NAME}] match ${neu.id} ended; rejoining lobby`);
        joinLobby(conn);
      }
    }
  });
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
  const inRunning = Array.from(conn.db.matchParticipant.iter()).some((p) => {
    if (p.botId !== myBotId) return false;
    const m = conn.db.matchState.id.find(p.matchId);
    return m?.status.tag === "Running";
  });
  if (inRunning) return;
  const openLobby = Array.from(conn.db.lobby.iter()).find(
    (l) => l.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.lobbyMember.iter()).some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId,
    );
  if (alreadyIn) return;
  console.log(`[${BOT_NAME}] joining lobby`);
  conn.reducers.joinLobby({}).catch(logFailure("joining the lobby"));
}

function bootstrapActivity(conn: DbConnection) {
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() =>
        console.log(`[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`),
      )
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  joinLobby(conn);
  // Safety net: periodically re-check lobby, open auctions, and words so a
  // missed event never stalls the bot.
  setInterval(() => {
    joinLobby(conn);
    for (const a of conn.db.auction.iter()) {
      if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
    }
    tryPlayWord(conn);
  }, 1500);
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  }
  tryPlayWord(conn);
}

function main() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) =>
      console.error("connect error:", err.message),
    )
    .onDisconnect(() => {
      console.log("disconnected; reconnecting in 2s");
      setTimeout(main, 2000);
    })
    .build();
}

main();
