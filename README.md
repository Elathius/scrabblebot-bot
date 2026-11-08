# ScrabbleBot entry

A bot for [ScrabbleBot](https://scrabblebot.spacetimedb.com/), the Scrabble-style
tile auction game built on [SpacetimeDB](https://spacetimedb.com). Based on the
official [bot starter](https://github.com/clockworklabs/scrabblebot/tree/main/bot-starter)
(commit `b5ccb36`), with the strategy and lifecycle rewritten.

## Strategy

**Word engine** (`src/strategy.ts`)
- The 172k-word official list is preprocessed once into letter-count vectors
  with exact server rewards (`floor(sum * multiplier)`), dropping words that
  are physically impossible with the 98-tile bag.
- `WordEngine.best(rack)` finds the highest-scoring *combination* of words
  playable from a rack (memoized by rack multiset, bounded branching). The
  starter's longest-word greedy gets 24 on `AEINRSTOX` (NOTARIES, X stranded);
  this engine finds 44 (ANTISEX + OR). Typical racks solve in under 30 ms.
- `bestNear(rack, d, minLen)` finds the best word that is `d` tiles short,
  used to value tiles that set up long words.

**Bidding** (`decideBid`)
- Marginal value of a tile: `value(rack + tile) - value(rack)`, where value is
  realizable score now plus a horizon-discounted bonus for near-complete long
  words. A 1-point E that completes a 7-letter word is worth far more than a Q.
- Cash's opportunity cost (`lambda`) falls as the bag empties. Bids are paced
  early (at most 40% of the bank) and unconstrained late.
- Cheap pickups: unbid tiles are consumed, so useful letters get a reserve-price
  bid while the rack has room.
- Vickrey and first-price modes are read from the live match state.

**Endgame** (verified against server source)
- `bagTotal == 0` means the offered tile is the last one and the match ends in
  the same transaction that settles it. The bot never pays for it and instead
  liquidates its rack while the last few auctions run.
- `bagTotal == 1` is the last usable tile: cash has no future value, so the bot
  bids its full balance if the tile improves realizable score.

**Play / hold** (`chooseWords`)
- Play 7+ letter words immediately (multiplier is maxed). Play strong 5-6
  letter words. Hold small racks when a near-complete 6+ letter word is worth
  more than cashing in now. Convert when crowded, cash-starved, or late.

**Reliability** (`src/index.ts`)
- Subscribes only to this bot's own rows and the matches it is seated in,
  via filtered SQL subscriptions. `subscribeToAllTables` (what the starter
  does) streams every match on the server through the client; in live play
  that delayed reducer replies by seconds and every bid arrived after the
  auction had closed.
- Bid deadline guard: skips a bid when fewer than 150 ms remain.
- Tracks the median price paid in the current match and the number of
  seated bots; bids are sized so winning a fair share of the remaining
  tiles spends the whole bankroll, since cash is worth nothing at the end.
- One word submission in flight per match with timeout, re-plan after each
  confirmation (multiword plans and liquidation).
- Re-plans on rack changes *and* on match progression (`bagTotal`).
- Periodic safety tick for lobby, open auctions and words. Auto reconnect.
- Bids are only marked attempted after they are accepted.

## Run

```sh
npm install
# First run, token from your team page at https://scrabblebot.spacetimedb.com/team
BOT_NAME=<name> BOT_TOKEN=<token> npm start
# Later runs (token is cached in .token-<name>, which is git-ignored)
BOT_NAME=<name> npm start
# Register for a tournament
BOT_NAME=<name> TOURNAMENT_ID=<id> npm start
```

`src/module_bindings` are the generated SpacetimeDB bindings copied from the
official repo so the Spacetime CLI is not needed. `wordlist.txt` is the official
dictionary.

```sh
npm test   # strategy tests
```

## License

MIT, same as the upstream starter. See `LICENSE`.

## Offline arena

`npx tsx sim/sim.ts 30` replays the server rules (Vickrey, random ties,
consumed unbid tiles, unplayable final tile) against the server's simulated
strategies, the official starter, a mirror of this bot, and "one-prompt AI"
style bots that pace spending and hold for 5+ letter words. Over 30 games
the bot averaged about 120 points, finishing first in 22 and never below
fourth. Those opponents are not the real field, so treat it as a tuning
harness, not a guarantee.
