[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/nanagajah244/makefun-btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/nanagajah244/makefun-btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

# Ember Trend — cbBTC 1-minute trend bot

A bot for the make.fun competition **"Race a BTC trading bot live for 24 hours"**
(`btc-race-24h-20261123-0511`). It trades Coinbase Wrapped BTC (cbBTC) against
USDC on 1-minute on-chain bars, speaking the `agent-fun/bars-replay/v1` protocol
(newline-delimited JSON on stdin/stdout, one reply per batch echoing its `seq`).

## Strategy

Long-only, one position at a time, full-size entries (98% of cash, keeping a
fee buffer). A round trip costs ~26 bps, so the bot only trades on a confirmed
trend and never chases a single-bar spike — fills land at the *next* bar's
open, so the signal has to survive a minute.

- **Entry:** fast EMA (30 bars) above slow EMA (120 bars) by at least 0.05%,
  and the trailing 60-bar return between +0.15% and +4.00%. Flat chop and
  vertical spikes are both skipped. No entries before 122 bars of history,
  or in the last 30 bars of the window.
- **Exit:** price breaking 0.20% below the slow EMA, a 2.50% trailing stop off
  the peak close since entry, a 2.50% hard stop under entry cost, or a 5.00%
  take-profit.
- **Drawdown guard:** if equity falls 4% below its peak, the position is
  flattened and no new entries are taken for 60 bars.
- **No entries** in the last 30 bars of the window.

## Determinism

Every decision is a pure function of the bars seen so far. No network, no
wall clock, no environment reads, no files, no randomness. Two runs on the
same window produce byte-identical action logs.

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, standard library only).
- `vendor/makefun-bars.ts` — the kit's bars-replay SDK shim, copied byte-for-byte.
- `LICENSE` — MIT.

## Local grading

From the kit directory:

```
node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process
```

## Dev-window result

See `build-report.md` in the bounty work directory (kept out of this repo).
