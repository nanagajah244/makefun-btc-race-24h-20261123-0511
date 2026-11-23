// Ember Trend — a cbBTC trend-following bot for agent-fun/bars-replay/v1.
//
// Strategy (original design, written from the competition brief + kit docs):
//   * Long-only, one position, full-size entries. Fills land at the NEXT bar's
//     open, so every signal must survive one minute: entries need a confirmed
//     trend (fast EMA above slow EMA with a minimum spread) plus a positive
//     60-bar return inside a sane band (no chasing a spike that already ran).
//   * Exits on price breaking below the slow EMA, a trailing stop off the
//     peak close since entry, a hard stop under entry cost, or a take-profit.
//     A drawdown guard flattens the book and cools down after a sharp equity drop.
//   * No network, no wall clock, no environment reads, no files, no randomness:
//     every decision is a pure function of the bars seen so far, so two runs
//     on the same window produce byte-identical action logs.
//
// All prices here are raw integer units (price_scale is constant), so ratios
// and EMA levels are scale-free. Amounts are BigInt quote units (1e-6 USDC).

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- tunable parameters (chosen for robust plateaus, not a knife edge) ---
// 1-minute bars whipsaw fast crossovers (the house EMA8/21 bot lost -$114.83
// on this window with 76 trades), while buy-and-hold made +$32.17. So: enter
// on a confirmed medium-term trend, hold through noise with a wide trailing
// stop, and exit only when price breaks below the slow trend line (a stronger
// reversal signal than a fast/slow EMA cross, which flips on mere chop).
const EMA_FAST = 30; // bars (30m)
const EMA_SLOW = 120; // bars (2h)
const MIN_BARS_FOR_ENTRY = 122; // bars of history before the first entry
const LOOKBACK_RET = 60; // bars for the momentum confirmation
const ENTER_MIN_RET_BPS = 15; // 60-bar return must be at least +0.15%
const ENTER_MAX_RET_BPS = 400; // ...and at most +4.00% (never chase a spike)
const ENTER_MIN_SPREAD_BPS = 5; // fast EMA must clear slow EMA by 0.05%
const EXIT_BELOW_SLOW_BPS = 20; // exit when close is 0.20% under the slow EMA
const TRAIL_BPS = 250; // trailing stop: 2.50% below peak close since entry
const STOP_BPS = 250; // hard stop: 2.50% below entry cost
const TAKE_PROFIT_BPS = 500; // take profit: 5.00% above entry cost
const DD_GUARD_BPS = 400; // equity 4.00% below its peak -> flatten + cooldown
const COOLDOWN_BARS = 60; // bars to sit out after the drawdown guard fires
const BUY_FRACTION_BPS = 9800; // spend 98% of cash per entry (fee buffer)
const MAX_SLIPPAGE_BPS = 150; // 1.50% vs latest close (fills: ~2 slip + ~7 impact)
const NO_ENTRY_AFTER_BARS = 1410; // stop opening new trades near the window end

interface BotState {
  closes: number[];
  emaFast: number | null;
  emaSlow: number | null;
  barsSeen: number;
  peakEquity: bigint;
  peakCloseSinceEntry: number;
  entryCostPerUnit: number; // quote units per asset unit at entry (from fills)
  cooldownUntilSeq: number;
  guardTripped: boolean;
}

function freshState(): BotState {
  return {
    closes: [],
    emaFast: null,
    emaSlow: null,
    barsSeen: 0,
    peakEquity: 0n,
    peakCloseSinceEntry: 0,
    entryCostPerUnit: 0,
    cooldownUntilSeq: -1,
    guardTripped: false,
  };
}

const s: BotState = freshState();

function emaUpdate(prev: number | null, price: number, period: number): number {
  if (prev === null) return price;
  const k = 2 / (period + 1);
  return price * k + prev * (1 - k);
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar !== undefined) {
    const close = Number(BigInt(bar.c));
    s.closes.push(close);
    if (s.closes.length > 400) s.closes.shift();
    s.emaFast = emaUpdate(s.emaFast, close, EMA_FAST);
    s.emaSlow = emaUpdate(s.emaSlow, close, EMA_SLOW);
    s.barsSeen += 1;
  }

  // Track the equity peak for the drawdown guard (harness-reported equity).
  if (state.equity > s.peakEquity) s.peakEquity = state.equity;

  const pos = state.positions.get(SYMBOL);
  const qty = pos === undefined ? 0n : pos.qty;
  const closeNow = state.close(SYMBOL);
  const orders: OrderInput[] = [];

  // --- drawdown guard: flatten and cool down -------------------------------
  if (s.peakEquity > 0n && s.guardTripped === false) {
    const floor = (s.peakEquity * BigInt(10_000 - DD_GUARD_BPS)) / 10_000n;
    if (state.equity < floor) {
      s.guardTripped = true;
      s.cooldownUntilSeq = state.seq + COOLDOWN_BARS;
      if (qty > 0n) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        return orders;
      }
      return orders;
    }
  }
  if (s.guardTripped && state.seq >= s.cooldownUntilSeq) s.guardTripped = false;

  if (closeNow === null || s.emaFast === null || s.emaSlow === null) return orders;
  const close = Number(closeNow);

  // --- manage an open long -------------------------------------------------
  if (qty > 0n) {
    if (close > s.peakCloseSinceEntry) s.peakCloseSinceEntry = close;
    // Entry cost per asset unit, from the harness-reported cost (fees in),
    // refreshed each batch from the position (see refreshEntryCost).
    const costPerUnit = s.entryCostPerUnit;
    const trailPrice = s.peakCloseSinceEntry * (1 - TRAIL_BPS / 10_000);
    const stopPrice = costPerUnit * (1 - STOP_BPS / 10_000);
    const tpPrice = costPerUnit * (1 + TAKE_PROFIT_BPS / 10_000);
    // Exit when price breaks below the slow trend line (not on a fast/slow
    // cross, which flips on chop), or on a stop / take-profit.
    const brokeDown = close < s.emaSlow * (1 - EXIT_BELOW_SLOW_BPS / 10_000);
    if (brokeDown || close <= trailPrice || close <= stopPrice || close >= tpPrice) {
      orders.push({ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }
    return orders;
  }

  // --- flat: look for an entry ---------------------------------------------
  if (state.warmingUp) return orders;
  if (s.barsSeen < MIN_BARS_FOR_ENTRY) return orders;
  if (s.barsSeen >= NO_ENTRY_AFTER_BARS) return orders;
  if (s.guardTripped) return orders;
  if (state.seq < s.cooldownUntilSeq) return orders;

  const n = s.closes.length;
  if (n <= LOOKBACK_RET) return orders;
  const retLookbackBps = ((s.closes[n - 1] / s.closes[n - 1 - LOOKBACK_RET]) - 1) * 10_000;
  const spreadBps = ((s.emaFast - s.emaSlow) / close) * 10_000;
  const trendingUp = s.emaFast > s.emaSlow && spreadBps >= ENTER_MIN_SPREAD_BPS;
  const momentumOk = retLookbackBps >= ENTER_MIN_RET_BPS && retLookbackBps <= ENTER_MAX_RET_BPS;
  if (!trendingUp || !momentumOk) return orders;

  const cash = state.cash;
  const notional = (cash * BigInt(BUY_FRACTION_BPS)) / 10_000n;
  if (notional < 1_000_000n) return orders; // below $1 minimum
  // Record the entry price for stop / take-profit math (fills at next open,
  // so the true cost is learned from the next batch's position cost).
  s.peakCloseSinceEntry = close;
  s.entryCostPerUnit = close;
  orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
  return orders;
}

function onHello(state: BarsState): void {
  // Seed the entry-cost tracker from hello so the first batch has sane state.
  void state;
}

// After each batch's fills land, refresh the entry cost from the harness:
// cost_quote_units / qty is the true per-unit cost (fees included).
function refreshEntryCost(state: BarsState): void {
  const pos = state.positions.get(SYMBOL);
  if (pos !== undefined && pos.qty > 0n) {
    const qtyScale = state.symbols.get(SYMBOL)?.qty_scale ?? 8;
    const priceScale = state.symbols.get(SYMBOL)?.price_scale ?? 5;
    const quoteScale = state.hello.capital.quote_scale;
    // cost per unit in raw price units: cost * 10^(qty+price) / (qty * 10^quote)
    const cost = Number(pos.cost) * 10 ** (qtyScale + priceScale) / (Number(pos.qty) * 10 ** quoteScale);
    if (Number.isFinite(cost) && cost > 0) s.entryCostPerUnit = cost;
  }
}

await runBars({
  onHello,
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    refreshEntryCost(state);
    return onBatch(state, batch);
  },
});
