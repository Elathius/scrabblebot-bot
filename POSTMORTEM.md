# Post-mortem: ScrabbleBot Tournament 3, HackUTD, 7 November 2026

**Result:** did not make the cut. 9 Swiss points, 224 total score, rank 60 of 62
entries after four Swiss rounds. Top 6 advanced with 14 to 17 points.

Bot: `Elathius` (id 354), team Elathius, one credential, one registration.
Final code: this repository at the commit tagged in the git log as the
tournament build (letter-value prior + market-rate early floor).

## Timeline

| Time (CST) | Event |
| --- | --- |
| ~22:05 | Started from the official starter. Replaced strategy with an exact multiword rack solver, marginal-value bidding, endgame handling. Pushed public repo. |
| ~22:20 | Team created via CLI, credential claimed via nonce, bot connected and registered for tournament 2. |
| ~22:30 | First live match: last place, 18 points, 118 coins unspent. Every bid rejected "Auction closed". |
| ~22:35 | Root cause: `subscribeToAllTables` streamed every match on the server through the client; reducer replies lagged by seconds. Switched to per-match filtered subscriptions. Bids then landed with ~1 s to spare. |
| ~22:40 | Bidding rewritten to spend the whole bankroll over a fair share of remaining tiles (cash is worth nothing at the end). Scores jumped to 101, 89, 104. |
| ~22:45 | Tournament 2 deleted by organizers. Added auto-registration; bot registered for tournament 3 seconds after it was created. |
| ~22:50 | Offline arena (`sim/sim.ts`) built. Bot averaged ~120 and won most games against the server's sim strategies, the starter, and "one-prompt AI" clones. |
| ~23:00 | Tile valuation rewritten around distance to 7+ letter words. Live scores 159, 143, 101 in warm-ups. |
| ~23:10 | Bid-deadline failures rose to ~10% as 72 bots connected. Measured TCP connect of 190-385 ms to the server from venue Wi-Fi. Cached and pre-warmed engine lookups; bids now decided in ~25 ms and sent before any word-engine work. |
| ~23:15 | A restart between matches failed (`setsid` does not exist on macOS); bot was down ~90 s during registration. |
| ~23:20 | User's Wi-Fi reconnect killed the socket silently; server showed offline while the client thought it was connected. Restarted. |
| ~23:25 | Warm-up placements slid to 3rd-6th against the full tournament field. Diagnosed: rack full of 1-point letters; heavy letters bid at 1-2 coins. Added letter-value prior. |
| ~23:40 | Diagnosed empty-rack underbidding (bot held 89 coins for 30 auctions bidding 7 vs market 13). Prepared a market-rate floor. |
| 23:42 | Tournament flipped to Swiss. Restarted in the gap after our last lobby match; round 1 began during the restart and the bot missed ~15 of 68 auctions. Round 1: 6th place. |
| 23:45-00:00 | Rounds 2-4: 4th, 4th, 5th. Eliminated at the cut. |

## What worked

- **Exact multiword solver.** On the brief's reference rack it finds 44 where
  the starter's greedy finds 24. Live, it produced FOXHOLE 63, DOVEKIE 45,
  ADJOURNS 48, CODIFIER 42, SAXTUBA 48.
- **Filtered subscriptions.** The single biggest fix. Without it no bid ever
  lands. Any bot built on the starter as-is has this problem.
- **Spend-everything pacing.** Unspent cash fell from 118 to under 10 per match.
- **Endgame handling.** Never paid for the unplayable final tile; liquidated
  racks in the last few auctions.
- **Auto-registration and reconnect.** Registered for a new tournament within
  seconds of its creation; recovered from a network drop without intervention.
- **Fair play.** One team, one bot, one credential, one registration, own
  reducers only.

## What lost

1. **Restarting at the round 1 boundary.** The restart to ship the empty-rack
   fix overlapped the start of round 1. Missing the first 15 auctions against
   five bots who kept buying produced a last place (1 Swiss point) that the
   remaining rounds could not recover from. Rule for next time: no restart
   within a minute of any round transition, whatever the fix.
2. **Simulator opponents were far weaker than the field.** The arena said
   ~120 points and first place most of the time. The real field's winners
   played 8-letter heavy-letter words for 66-78 points (HOACTZIN, QUATORZE,
   BANJAXED, HEXAGON) and one bought half the bag by recycling word cash.
   Tuning against the arena produced a bot that beat sim bots and placed
   3rd-6th against humans' bots.
3. **Tile valuation discovered the heavy-letter problem too late.** The
   near-word search only credits a letter once a word is within 3 tiles, so
   early in a match every letter looks alike and the bot drifts toward
   cheap, easy letters. The prior that fixes this shipped 20 minutes before
   the start with no time to validate against the real field.
4. **Empty-rack underbidding.** After playing its starting rack as a 7-letter
   word, the bot had no tiles, saw zero marginal value in every letter, and
   bid under market for half a match. Fixed in the final build but see (1).
5. **Network.** Venue Wi-Fi gave 190-385 ms TCP connects with jitter; about
   1 in 10 bids arrived after the 1 s auction closed. Every bot in the room
   faced this, but a wired connection or a nearby cloud VM would have been
   a real edge.

## Numbers

- 52 matches played on the v2+ builds, average 76, best 160.
- Tournament rounds: 50, 61, 60, 53 (places 6, 4, 4, 5).
- Arena (30 games, mixed sim/starter/AI-clone tables): avg 120, 22 firsts,
  never below 4th. This number was misleading; see "What lost" (2).

## If doing it again

- Run the bot on a VM near the server, not a laptop on venue Wi-Fi.
- Build the arena opponents from real match logs (`auction_result`,
  `word_play` are public) before tuning anything.
- Value tiles by expected contribution to an 8+ letter word: multiplier caps
  at 7 letters but letter sums keep growing, and the winners played 8s.
- Freeze the build 15 minutes before the start. No exceptions.
- Watch the server's `bot_credential.connected` flag, not the client's
  opinion, after any network event.

## Related documents

- `docs/brief.md` — the pre-event research brief: verified game mechanics,
  dictionary findings, strategy proposals, and the setup flow. Written before
  any code; several of its warnings (starter lifecycle, subscription load,
  endgame tile) turned out to be exactly the live failures.

## Repository map

- `src/strategy.ts` — dictionary preprocessing, exact multiword solver,
  near-word search, bidding, play/hold.
- `src/index.ts` — connection, filtered subscriptions, bid deadline guard,
  auto-registration, reconnect, word submission queue.
- `sim/sim.ts` — offline arena replaying server rules against opponent mixes.
- `wordlist.txt` — the official dictionary. `src/module_bindings/` — generated
  SpacetimeDB bindings copied from the official repo.
