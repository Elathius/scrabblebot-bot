# ScrabbleBot: research, competitive strategy, and implementation brief

## 1. Mission and scope

Build a competitive bot for https://scrabblebot.spacetimedb.com/ using the official starter where practical. Optimize tournament performance through correct game modeling, strong word selection, adaptive bidding, reliable execution, and measured evaluation against diverse opponents.

The user challenged the initial strategy because other teams can obtain the same advice from an AI in one prompt. Treat the initial strategy as a baseline, not a distinctive winning solution. The next level is an evaluation-driven development process: simulate candidate decisions against plausible opponents, search for counterstrategies, and improve without sacrificing latency or correctness.

No strategy is guaranteed to beat every other strategy. Hidden starting tiles, random draws, and simultaneous bids create uncertainty. Do not claim a winning bot, optimal policy, or measured performance without evidence.

This file compiles research and proposals from the conversation. It is an implementation handoff, not evidence that the bot or simulator has already been built. Only the small dictionary/word-selection checks described below were executed. No tournament entry, deployment, or competition win has been verified.

## 2. Challenge supplied by the user

Two separate tracks:

| Track | Qualification stated by organizers | Prizes per team |
| --- | --- | --- |
| Main Track | Build any app or game; public GitHub repository; majority of backend built on Spacetime; access code available at booth | 1st $2,048; 2nd $1,024; 3rd $512 |
| ScrabbleBot Track | Build a bot for the auction word game; submit a public GitHub repository | 1st $1,024; 2nd $512; 3rd $256 |

The supplied announcement says “11 pm Saturday” for ScrabbleBot. Confirm the actual event date, local time, submission cutoff, and registration cutoff with organizers; do not infer that an old announcement is a current schedule.

The Main Track's backend requirement is separate from the ScrabbleBot repository requirement. Do not build an unnecessary additional backend just to enter ScrabbleBot.

## 3. Evidence and source precedence

Research was performed on November 7, 2026. Official repository inspected:

https://github.com/clockworklabs/scrabblebot

Pinned commit:

`b5ccb36aa238ad16692f8d6af54da15ef9f11324`

The deployed website JavaScript was also retrieved. Its client schema includes starting-rack size and auction-duration fields. The downloaded client referenced `https://maincloud.spacetimedb.com` and database `scrabblebot`. This does not prove the deployed server matches the pinned source exactly or establish live tournament settings.

Prefer observed live settings and verified server behavior over prose documentation. The README and bot guide contain stale or oversimplified statements. Before implementation, inspect the checkout, its instructions, generated bindings, dependency versions, and relevant changes since the pinned commit. Preserve unrelated user changes.

Evidence labels throughout this brief:

- **Verified source behavior:** established from the pinned official implementation.
- **Local check:** a small computation using the official wordlist.
- **Proposed strategy:** requires simulation and live validation.
- **Unverified live setting:** must be confirmed before tournament participation.

Do not silently turn a source default into a claim about the live tournament.

## 4. Actual game mechanics

| Mechanic | Verified behavior in pinned source |
| --- | --- |
| Starting money | 100 per bot |
| Starting tiles | Five hidden tiles per bot by default; configurable |
| Bag | 98 tiles, standard Scrabble distribution, no blanks |
| Auction duration | 1,000 ms default; configurable |
| Auction mode | Vickrey/second-price or first-price |
| Ties in bids | Randomized by shuffling before stable descending sort |
| Valid bids | Nonnegative integer amounts, no greater than current balance; only before auction deadline |
| Bid revision | A later bid replaces the same bot's previous bid in that auction |
| Payment | First-price pays own bid; Vickrey pays second positive bid, or reserve 1 when alone |
| Unbid tile | No return-to-bag logic in inspected settlement path; the draw has consumed it |
| Word submission | At least two ASCII A–Z letters after normalization; exact dictionary membership; enough rack tiles |
| Board | No Scrabble board or placement constraints |
| Word reward | Added to both spendable balance and cumulative score |
| Ranking | Score determines match placement; remaining cash does not directly score |
| Match end | Final auction settles and ends match in the same transaction |
| After match end | External word submissions are rejected |

Scoring:

`reward(word) = floor(sum(letter values) * length multiplier)`

| Length | Multiplier |
| --- | --- |
| 2–3 | 1.0 |
| 4 | 1.5 |
| 5 | 2.0 |
| 6 | 2.5 |
| 7 or more | 3.0 |

The multiplier stops growing at seven letters. Longer words may still improve total points or tile utilization, but have no extra multiplier tier.

Letter values:

```text
A1 B3 C3 D2 E1 F4 G2 H4 I1 J8 K5 L1 M3
N1 O1 P3 Q10 R1 S1 T1 U1 V4 W4 X8 Y4 Z10
```

Bag counts:

```text
A9 B2 C2 D4 E12 F2 G3 H2 I9 J1 K1 L4 M2
N6 O8 P2 Q1 R6 S4 T6 U4 V2 W2 X1 Y2 Z1
```

With six bots and five starting tiles each, 68 tiles remain for auctions. At default timing, auctions take approximately 68 seconds plus scheduling/network overhead. With two bots and the same starting rack size, 88 remain. Read actual settings rather than hardcoding these counts.

Documentation discrepancies to retain:

- README says unbid tiles return to the bag; inspected settlement code does not do that.
- Older indexed documentation says earliest tied bidder wins; pinned implementation randomizes ties.
- Guide suggests opponents' racks/bag can be derived from public history; hidden initial deals prevent exact reconstruction in general.
- Guide lists winning bids among observable auction results; current live visibility gates them away from bot credentials.
- README describes a 60-second lobby; source constant is 90 seconds in this snapshot.
- README's “best-of-three” finals shorthand is misleading: implemented final uses aggregate score over three games.
- Documentation's “truth-telling is optimal” is a single-auction intuition, not a proof for this budget-constrained sequential competitive game.

## 5. Critical endgame behavior

The server draws a tile when opening an auction. `bagTotal` excludes the currently offered tile.

Under the pinned code:

| Observed state | Meaning | Bot response |
| --- | --- | --- |
| `bagTotal > 1` | More than one tile remains undrawn | Normal horizon-aware planning |
| `bagTotal == 1` | Current auction offers the last tile an external bot can acquire and subsequently use | Value it against final rack conversion; spend aggressively only if useful |
| `bagTotal == 0` | Final auction is open | Submit existing playable words before close; do not buy this final tile for own scoring |
| Match ended | No further external word play | Stop actions and handle next match |

The final settlement gives the winner its tile and marks the match ended before an external client can react. Thus the final offered tile cannot contribute to an external bot's score under this implementation.

Start liquidation early enough to submit multiple words and receive confirmation. Trigger decisions on auction/match progression even if the rack has not changed. Never depend on a last-millisecond race. Reconfirm this behavior if server code changes.

In the last usable auction, remaining cash has no later purchasing value. Bidding the full affordable balance can be justified if the tile improves realizable score, subject to the current game state and confirmed endgame rules. This is not a general early-game bidding policy.

## 6. Dictionary and word-engine findings

Use `spacetimedb/wordlist.txt` from the matching official version. The inspected file contains 172,820 entries, with lengths from 2 to 28.

Local membership checks:

| Word | Accepted by supplied dictionary |
| --- | --- |
| QI | No |
| ZA | No |
| QAT | Yes |
| QUIZ | Yes |
| RETINAS | Yes |
| STAINER | Yes |

Do not rely on another Scrabble dictionary, an LLM's vocabulary, or familiar two-letter word lists. `JAZZ` is in the dictionary but impossible with one Z and no blanks. Filter future target words against physical tile limits and known availability constraints.

Verified fixed-rack experiment:

Rack: `AEINRSTOX`

| Method | Plays | Score |
| --- | --- | --- |
| Starter's longest-first greedy selection, repeated until no play remains | NOTARIES; X stranded | 24 |
| Exact best combination of words from the rack | TOXINES + AR | 44 |

TOXINES has base value 14 and earns 42; AR earns 2. This is roughly 83% more score on one illustrative rack. It is not a measured average improvement or win-rate estimate.

Word-engine requirements:

1. Preprocess uppercase words into 26-letter count vectors, lengths, and exact integer rewards.
2. Generate playable words efficiently; a trie or indexed count-vector approach is acceptable.
3. Find promising words missing one or two tiles; consider a larger neighborhood only after profiling.
4. Find the highest-total-scoring combination of words obtainable from the current rack.
5. Cache by a canonical multiset representation, not letter order.
6. Keep a best-so-far answer under time/node limits; label bounded results as approximate.
7. Preload everything before live auctions; avoid network dictionary lookups.

Terminal rack value:

```text
F(R) = max(0, max over legal words w contained in R of [reward(w) + F(R - w)])
```

Memoize by rack contents. Preserve multiplicities and permit repeated words if distinct tiles support them. Bound search for large racks. This is exact only when the search completes; it is terminal conversion value, not a full early-game strategy.

## 7. Baseline strategy: build this before advanced planning

### Tile valuation

Immediate marginal value:

```text
deltaImmediate(letter) = F(rack + letter) - F(rack)
```

This misses useful setup letters, so add a bounded future-opportunity estimate based on near-complete words, remaining opportunities, plausible tile availability, budget, and competition.

Do not assign the entire reward of a target word to each missing tile. Avoid double-counting overlapping targets or treating incompatible word plans as simultaneously realizable.

A one-point E can be more valuable than a ten-point Q if it completes a strong word. Generic vowel balance and duplicate penalties can support a fallback, but should not override concrete word opportunities.

### Play versus hold

Compare immediate score plus future value of the remaining rack and increased cash against holding the current rack. Explicitly include “play nothing” as a candidate action.

- Early, with enough cash: preserve promising combinations when completion is plausible.
- Cash constrained: a smaller word may fund several profitable acquisitions.
- Near a strong completion: holding may dominate spending its tiles on weak words.
- Late: abandon improbable targets and maximize rack conversion.
- With several ready words: optimize their combined value and the order of submissions.

### Bidding

For Vickrey, estimate incremental strategic value and cap by current balance and future purchasing needs. Do not bid the whole balance routinely just because the winner pays second price.

For first-price, model the probability of winning at each candidate bid and the actual cost:

```text
expectedBenefit(b) ≈ P(win | b) * [deltaScore - lambda * b]
```

`lambda` is the estimated future scoring opportunity cost of spending a currency unit. This is a heuristic, not an optimality theorem. Its value generally declines as useful buying opportunities disappear.

Cash is not score. Spending 30 currency for ten additional terminal points can be reasonable when the money has no better remaining use.

## 8. How to outperform bots with the same baseline

The user's core concern is valid: one-shot AI advice is easy for competitors to reproduce. The proposed differentiator is stronger empirical evaluation plus opponent-aware planning, not claiming a secret universally superior formula.

### Diverse opponent population

Build an arena containing:

- Original starter policy.
- Face-value and conservative buyers.
- Aggressive early buyers.
- Patient long-word hoarders.
- Early scorers prioritizing cash flow.
- Strong immediate word optimizers.
- Multiword packing plus marginal-value bidders.
- Adaptive budget policies.
- Earlier versions of our own bot.
- Public competitors where licensing and compatibility permit.

Use mixed tables, not only repeated copies of the same policy. Reserve some opponent policies and seeds exclusively for evaluation.

Potential counters are hypotheses to test:

| Opponent pattern | Candidate adaptation |
| --- | --- |
| Aggressive early spending | Preserve purchasing power when early prices are unjustified |
| Long-word hoarding | Score earlier when cash flow can win useful tiles |
| Conservative marginal bids | Acquire more useful tiles when prices support it |
| Likely decisive opponent completion | Consider denial value alongside own scoring value |
| Reckless buying | Avoid matching wasteful spending and compete when their funds decline |

These responses are conditional, not universal rules.

### Candidate-action rollouts

For each auction, evaluate a small set of bids, including zero, and feasible word-play/hold choices:

1. Construct possible hidden states consistent with observed information.
2. Sample opponent policy types and bids.
3. Apply exact auction rules, legal balances, word consumption, and timing.
4. Simulate subsequent actions with fast policies over a bounded horizon.
5. Use terminal rack conversion or a calibrated continuation estimate at the horizon.
6. Score outcomes according to tournament objective.
7. Select the best supported action within the latency budget.

Use the same sampled hidden states and random outcomes for candidate comparisons where possible. This reduces comparison noise. Do not let a rollout policy access hidden information unavailable to the real bot; distinguish simulator ground truth from each policy's observation.

Use a fast baseline if the planner exceeds its deadline or state changes invalidate its result. Deeper search under an inaccurate simulator is not necessarily an improvement.

### Opponent uncertainty

Maintain multiple plausible models rather than one confident classification. Update beliefs from auctions, purchases, word plays, cash, and scores. Sparse evidence should cause gradual changes.

Evaluate actions under both the most likely opponent model and less favorable plausible alternatives. Tune this robustness tradeoff in the arena; do not optimize solely against one guessed behavior.

### Counterstrategy search

Repeat:

```text
candidate -> diverse evaluation -> search for a counterpolicy
          -> add counterpolicy to arena -> improve -> reevaluate all opponents
```

Search opponent aggression, patience, bid scales, spending schedules, and word thresholds. Preserve earlier opponents to detect regressions and cyclical weaknesses. Use self-play as one part of evaluation, not proof of universal strength.

## 9. Information available to the bot

Public/authorized observations include match state, participants' balances and scores, auction letters, auction winners and payments, word plays, and the bot's own rack view.

Own rack: `my_rack`, filtered by match. Private tables include holdings and bag composition.

Hidden starting tiles mean opponents' racks are not generally recoverable exactly from “auction purchases minus word plays.” Track partial knowledge and uncertainty. For sampled hidden states, enforce the complete history, nonnegative rack counts at every step, total starting rack size, and global tile conservation.

Remaining bag composition is likewise uncertain because other starting racks were privately dealt. Track exact known exclusions plus a distribution over unknown allocations. Account for unbid draws as consumed under the pinned rules.

Live winning bids are hidden from bot credentials by `visibleAuctionTopBids`; `auctionResult` exposes payment rather than the winning top bid. `auctionTopBidArchive` exposes top bids after match completion. Do not equate a Vickrey payment with the winner's bid or treat payments influenced by our own bids as unbiased opponent samples.

Use only the bot's authorized observations in live decisions. Do not build the strategy around bypassing visibility controls, extra spectator identities, scheduler calls, or administrative endpoints. Historical permitted data can inform offline calibration.

## 10. Tournament objectives

| Stage | Pinned implementation | Objective for planning |
| --- | --- | --- |
| Swiss | Points based on finishing place; tied scores share the higher place | Strong, consistent placement and qualification probability |
| Elimination | Last-place finisher is removed | Avoid elimination; adjust risk to distance from last place |
| Final | Two remaining bots play three games; aggregate score decides champion | Maximize probability of winning aggregate total |

Swiss standings use Swiss points, then tournament total score, then lower bot ID. Elimination last-place ties use tournament total score, then bot ID. Final aggregate ties use tournament total score, then bot ID.

A policy maximizing raw expected score can differ from one maximizing survival or championship probability. When safely above last place, avoid needless risk. When trailing with little time, consider actions with enough upside to change placement. These are proposed risk adaptations; validate them rather than assuming a simple threshold is optimal.

Test heads-up separately from six-player play. The supply per player and competition differ substantially.

## 11. Client architecture and reliability

Use TypeScript and the official starter initially. Add native code only when profiling demonstrates a meaningful bottleneck.

Extend strategy inputs beyond the original rack/letter/balance interface:

```text
match ID and state version
own rack, score, and balance
current auction ID, letter, mode, opensAt, closesAt
bagTotal and usable acquisition horizon
participant scores and balances
auction results and public word history
own initial rack and inferred hidden-state beliefs
tournament stage and aggregate standings
pending submissions and latency measurements
```

Suggested responsibility boundaries, adaptable to the existing repository:

```text
client / subscriptions / lifecycle
state reconstruction and observation filtering
dictionary preprocessing and word engine
terminal multiword solver
baseline bidding and play/hold policy
opponent beliefs and sampled states
bounded rollout planner
simulation arena and evaluation
telemetry and replay
```

Starter issues identified in the pinned source:

| Behavior | Required improvement |
| --- | --- |
| 500 ms word-attempt throttle | Explicitly schedule deferred retries; do not assume another rack event will occur |
| Word search triggered by rack inserts/updates | Also trigger on relevant auction/match progression and confirmed word completion |
| No rack-delete planning callback | Handle tiles consumed down to zero |
| Bid marked attempted before success | Track pending/success/failure and retry only while valid |
| Synchronous search blocks event handling | Cache/precompute; move expensive work to a worker if necessary |
| Disconnect handler only logs | Implement and test recovery plus authoritative state reconstruction |
| Broad subscription and retained history | Bound local work and filter active matches; measure before redesigning |

Execution requirements:

- At most one word submission in flight per match unless correctness of a more advanced queue is established.
- Reconcile confirmed state before the next word; never spend the same tile twice.
- Keep BigInt IDs/currency compatible with generated bindings; validate integer bids.
- Discard plans computed for obsolete rack/state versions.
- Respect server closesAt with a conservative latency allowance.
- Do not wait until the final milliseconds to bid; tie-breaking does not reward arrival order.
- Avoid unconditional polling, duplicate reducer calls, and blocking dictionary scans.
- Recover from initial connection failures, disconnects, and resubscription with a tested SDK-compatible method.
- Never log, commit, or publish bot tokens. Exclude `.token-*` and private environment files from the public repository.

## 12. Simulator and evaluation requirements

The simulator must match the relevant server semantics before strategy results are trusted:

- Bag distribution, private initial deals, draw depletion, and no blanks.
- Both auction payment modes, positive-bid handling, random ties, reserve price.
- Legal bid amounts and bid replacement semantics.
- Dictionary membership, multiplicities, floor rounding, word consumption, and score/cash updates.
- Word-play opportunities between auctions.
- Final-tile settlement and prohibition on external post-end word submissions.
- Tournament stage objectives and tie-breakers.

Use official tests and source as a reference. A simplified simulator may be useful for early development, but document discrepancies and do not present its results as deployment guarantees.

Metrics:

| Category | Measurements |
| --- | --- |
| Competitive | Win/placement distribution, last-place rate, Swiss advancement, aggregate finals performance |
| Economic | Acquisition prices, score gained, unused cash, cash starvation |
| Tile use | Stranded rack value, incomplete targets, late liquidation losses |
| Reliability | Missed auctions, rejected bids/words, reconnect recovery, stale-state actions |
| Speed | Median and tail decision latency, total submission latency |

Compare versions on paired seeds, rotating seats and starting conditions. Report sample size, uncertainty, opponent mix, rules, and evaluation seeds. Keep development seeds separate from final evaluation. Do not claim significance from a few favorable games.

Run ablations: remove opponent modeling, remove rollouts, replace multiword search with greedy, and disable adaptive spending. Keep added complexity only if it gives repeatable gains without unacceptable reliability costs.

Meaningful edge-case checks include repeated letters, unsupported dictionary words, impossible target multiplicities, integer reward rounding, no-bid depletion, random bid ties, bagTotal 0/1 boundaries, multiple sequential words, delayed callbacks, failed submissions, reconnects, and tournament entry transitions.

## 13. Public competitor research

Public forks inspected during research:

- https://github.com/Jose-Gael-Cruz-Lopez/afterword-scrabblebot/blob/main/bot-starter/src/strategy.ts
  - Near-word search, bounded multiword packing, future-value estimation, richer context, and explicit endgame bidding.
- https://github.com/junsooki/scrabblebot/blob/main/bot-starter/src/strategy.ts
  - Native word evaluator and immediate reward plus remaining-rack valuation; inspected bidding retained a simple baseline.
- https://github.com/garysun1/scrabblebot/blob/main/bot-starter/src/strategy.ts
  - Inspected strategy resembled the official baseline at research time.

These links are mutable. Their tournament results were not verified. Do not call any fork a proven champion based on class names, comments, or repository branding. Inspect licenses before reuse and preserve attribution where required.

The useful conclusion is that basic word optimization is already public. Better evaluation, timing, budget adaptation, and tournament-aware decisions are more plausible differentiators than longest-word search alone.

## 14. Setup and registration

Official documented flow:

1. Link the user's Spacetime identity at `/account`.
2. Create or join a team at `/team/new` or through an invitation.
3. Generate the bot credential token on `/team`.
4. Use the token with the bot client; keep it secret.
5. Register the bot for the actual tournament ID from the bot process.

Starter commands from the inspected project; verify installed prerequisites and current scripts before running:

```sh
git clone https://github.com/clockworklabs/scrabblebot
cd scrabblebot/bot-starter
npm install
npm run generate
# Set BOT_TOKEN privately in the environment, not in source or committed files.
BOT_NAME=chosen_name npm start
# Once the organizer supplies the real tournament ID:
BOT_NAME=chosen_name TOURNAMENT_ID=actual_id npm start
```

`npm run generate` requires the Spacetime CLI and installs module dependencies in the inspected starter. Follow the repository's installed SDK/generated bindings rather than unrelated version examples.

Relevant reducer calls:

```ts
conn.reducers.joinLobby({});
conn.reducers.submitBid({ auctionId, amount: BigInt(amount) });
conn.reducers.submitWord({ matchId, word });
conn.reducers.registerForTournament({ tournamentId });
```

Creating a team on the website is not tournament registration. Registration uses a bot credential. Registered offline bots can still be seated. Once a tournament starts, its active entrants cannot join ordinary lobby matches until eliminated or the tournament ends. Being in an ordinary match can delay tournament start. Stay connected and handle expected lobby refusals without crashing.

Confirm at the booth or through authoritative event information:

- Date/time, submission cutoff, registration cutoff, tournament ID.
- Server/database and correct generated bindings.
- Auction mode, duration, starting rack size, match size.
- Deployed final-tile and no-bid behavior.
- Tournament format and tie-breaking.
- Repository submission process and any competition-specific conduct constraints.

Do not publish, register, or deploy merely because this file describes how; follow the user's actual authorization for those external actions.

## 15. Recommended implementation order

1. Inspect the repository and reconcile rules with current source/settings. Establish a working client and exact dictionary/scoring.
2. Build fast playable-word search and bounded/exact multiword conversion. Reproduce the 24-versus-44 example.
3. Fix lifecycle, stale-state, retry, and endgame handling. Complete matches reliably.
4. Build a faithful arena and varied baseline opponents.
5. Implement marginal-value bids, budget control, and play-versus-hold decisions. Measure improvements.
6. Add near-word forecasts and adapt spending to horizon and competition.
7. Add limited hidden-state sampling and opponent-aware candidate rollouts only if time permits.
8. Search for counterpolicies, expand the arena, and evaluate on held-out cases.
9. Tune stage-specific risk and separately test heads-up finals.
10. Freeze a tested version, rehearse restart/reconnect/registration, and prepare the public submission without secrets.

If time is short, prioritize reliable execution, multiword selection, endgame handling, and evidence from a diverse arena. A modest validated planner is preferable to an elaborate unvalidated one. Preserve a known-good fallback throughout.

## 16. Reporting and acceptance criteria

Keep a concise record of source commit, rules assumed, experiments run, opponent policies, seeds, metrics, and unresolved issues.

Do not call the project complete until:

- A clean setup can load the matching dictionary and connect with a legitimate bot credential.
- Bid and word submissions respect the rules and observed state.
- The bot handles whole matches and the final auction correctly.
- The planner finishes inside the operational latency budget or uses a safe fallback.
- Strategy comparisons include diverse opponents and unseen seeds.
- Reconnection and tournament transitions have been exercised or clearly marked unverified.
- Public files exclude tokens and private data.
- The user receives an accurate account of what was built, what was tested, and what remains dependent on organizer/live access.

A winning strategy is an empirical claim. Describe the evidence, not an assurance that the bot beats any possible opponent.

## 17. Primary source index

All official code links below are pinned to the inspected commit:

- Repository snapshot: https://github.com/clockworklabs/scrabblebot/tree/b5ccb36aa238ad16692f8d6af54da15ef9f11324
- Game, auctions, initial dealing, match end: https://github.com/clockworklabs/scrabblebot/blob/b5ccb36aa238ad16692f8d6af54da15ef9f11324/spacetimedb/src/game.ts
- Reducers, validation, visibility: https://github.com/clockworklabs/scrabblebot/blob/b5ccb36aa238ad16692f8d6af54da15ef9f11324/spacetimedb/src/index.ts
- Letter values, distribution, multiplier: https://github.com/clockworklabs/scrabblebot/blob/b5ccb36aa238ad16692f8d6af54da15ef9f11324/spacetimedb/src/letters.ts
- Dictionary implementation: https://github.com/clockworklabs/scrabblebot/blob/b5ccb36aa238ad16692f8d6af54da15ef9f11324/spacetimedb/src/dictionary.ts
- Exact wordlist: https://github.com/clockworklabs/scrabblebot/blob/b5ccb36aa238ad16692f8d6af54da15ef9f11324/spacetimedb/wordlist.txt
- Starter strategy: https://github.com/clockworklabs/scrabblebot/blob/b5ccb36aa238ad16692f8d6af54da15ef9f11324/bot-starter/src/strategy.ts
- Starter lifecycle: https://github.com/clockworklabs/scrabblebot/blob/b5ccb36aa238ad16692f8d6af54da15ef9f11324/bot-starter/src/index.ts
- Tournament implementation: https://github.com/clockworklabs/scrabblebot/blob/b5ccb36aa238ad16692f8d6af54da15ef9f11324/spacetimedb/src/tournament.ts
- Bot guide, with caveats above: https://github.com/clockworklabs/scrabblebot/blob/b5ccb36aa238ad16692f8d6af54da15ef9f11324/docs/bot-guide.md
- Official server tests: https://github.com/clockworklabs/scrabblebot/tree/b5ccb36aa238ad16692f8d6af54da15ef9f11324/spacetimedb/src/tests
- Live site: https://scrabblebot.spacetimedb.com/
