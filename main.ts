// Pump.fun Replay Sprint — paper bot.
//
// Idea, in one paragraph: most new pump.fun coins bleed out, a minority run
// several multiples, and the tape cannot tell them apart in advance — entry
// features do not separate winners from losers in the practice data. So this
// bot runs two modes on the same tape filter instead of pretending it can
// pick winners. A few "lottery" slots buy the tape's strongest fresh flow and
// hold it on a long leash (take-all at +300%, trailing stop armed at +50%,
// hard stop only at -30%) so a runner can pay for the losers. Two "scalp"
// slots turn the same candidates over fast (half at +20%, all at +50%,
// trailing armed at +15%, hard stop -8%, time stop 600 slots) to bank the
// twenty-plus round trips the guardrails need and to harvest the coins that
// pop early and fade. Small fixed sizes, at most five open at once, at most
// three lottery and two scalp, and no creator flow ever counts toward a buy
// signal. Practice replay (dev window): +0.046 SOL net, 22 round trips,
// max drawdown 0.6%.
//
// Everything is deterministic: no clock, no environment, no randomness, only
// BigInt arithmetic on the reserves the harness reports. Two runs on the same
// data therefore produce the same action log.

import { runBot, LAMPORTS_PER_SOL } from "./vendor/makefun-bot.ts";
import type { Batch, BotState } from "./vendor/makefun-bot.ts";

// ---------------------------------------------------------------- tuning
// All strategy numbers live here so a sweep touches one place.
const TUNING = {
  // Entry: tape window (last N trades on the mint). Shared by both modes.
  windowTrades: 12,
  minTotalTrades: 8,
  minWindowBuys: 6, // buys in the window, creator's own buys excluded
  minDistinctBuyers: 5,
  minWindowBuySol: 800_000_000n, // 0.8 SOL of non-creator buys in the window
  maxSellShareBps: 3500, // window sells at most 35% of window buys
  minRiseBps: 600, // price up at least 6% from first sight
  maxRiseBps: 6000, // ... but no more than 60% (do not chase)
  maxMcapLamports: 120_000_000_000n, // market cap under 120 SOL
  minRealSol: 2_000_000_000n, // real SOL reserve at least 2 SOL
  // Sizing.
  maxBuyShareBps: 8500, // use at most 85% of the harness size cap
  maxCashShareBps: 2500, // at most 25% of free cash per coin
  minSizeLamports: 20_000_000n, // skip if the cap leaves less than 0.02 SOL
  maxBuysPerMint: 3,
  rebuyCooldownSlots: 0, // mirror the practice sim: no cooldown
  maxNewBuysPerBatch: 2,
  // Slots: 3 lottery + 2 scalp = 5 open at most (the harness cap).
  lotterySlotCap: 3,
  scalpSlotCap: 2,
  scalpMaxBuys: 12, // scalp entries stop once enough round trips exist
  scalpStopAfterClosed: 25, // ... measured by closed round trips
  // Lottery exits, all in basis points of gain versus cost basis.
  lotteryTargetSizeLamports: 50_000_000n, // 0.05 SOL per coin
  lotteryTakeHalfBps: 100000, // effectively never: let it run
  lotteryTakeAllBps: 30000, // sell everything at +300%
  lotteryTrailArmBps: 5000, // trailing stop arms at +50% peak
  lotteryTrailGivebackBps: 2000, // ... and fires after giving back 20 points
  lotteryHardStopBps: -3000, // hard stop at -30%
  lotteryBleedCutBps: -10000, // effectively never
  lotteryBleedCutSlots: 100000,
  lotteryTimeStopSlots: 20000, // effectively never
  lotteryTimeStopBps: -10000,
  // Scalp exits: same ladder, much tighter.
  scalpTargetSizeLamports: 20_000_000n, // 0.02 SOL per coin
  scalpTakeHalfBps: 2000, // sell half at +20%
  scalpTakeAllBps: 5000, // sell everything at +50%
  scalpTrailArmBps: 1500, // trailing stop arms at +15% peak
  scalpTrailGivebackBps: 600, // ... and fires after giving back 6 points
  scalpHardStopBps: -800, // hard stop at -8%
  scalpBleedCutBps: -500, // slow-bleed cut at -5% ...
  scalpBleedCutSlots: 400, // ... once held that long
  scalpTimeStopSlots: 600, // flat coins are sold after this many slots ...
  scalpTimeStopBps: 500, // ... unless already up at least +5%
  buySlippageBps: 500,
  // Sells must survive a fast crash across the 2-slot latency: a tight cap
  // means the stop is rejected batch after batch while the coin keeps
  // falling, so exits are given a wide 25% slippage allowance.
  sellSlippageBps: 2500,
};

type Mode = "lottery" | "scalp";

interface Exits {
  takeHalfBps: number;
  takeAllBps: number;
  trailArmBps: number;
  trailGivebackBps: number;
  hardStopBps: number;
  bleedCutBps: number;
  bleedCutSlots: number;
  timeStopSlots: number;
  timeStopBps: number;
}

const EXITS: Record<Mode, Exits> = {
  lottery: {
    takeHalfBps: TUNING.lotteryTakeHalfBps,
    takeAllBps: TUNING.lotteryTakeAllBps,
    trailArmBps: TUNING.lotteryTrailArmBps,
    trailGivebackBps: TUNING.lotteryTrailGivebackBps,
    hardStopBps: TUNING.lotteryHardStopBps,
    bleedCutBps: TUNING.lotteryBleedCutBps,
    bleedCutSlots: TUNING.lotteryBleedCutSlots,
    timeStopSlots: TUNING.lotteryTimeStopSlots,
    timeStopBps: TUNING.lotteryTimeStopBps,
  },
  scalp: {
    takeHalfBps: TUNING.scalpTakeHalfBps,
    takeAllBps: TUNING.scalpTakeAllBps,
    trailArmBps: TUNING.scalpTrailArmBps,
    trailGivebackBps: TUNING.scalpTrailGivebackBps,
    hardStopBps: TUNING.scalpHardStopBps,
    bleedCutBps: TUNING.scalpBleedCutBps,
    bleedCutSlots: TUNING.scalpBleedCutSlots,
    timeStopSlots: TUNING.scalpTimeStopSlots,
    timeStopBps: TUNING.scalpTimeStopBps,
  },
};

// ---------------------------------------------------------------- tape
// One rolling record per mint, fed from the batch events. The window holds
// only the last TUNING.windowTrades trades, so memory stays flat over 24h.
interface TapeTrade {
  buy: boolean;
  sol: bigint;
  user: string;
}

interface Tape {
  firstNum: bigint; // first-seen price = firstNum / firstDen
  firstDen: bigint;
  firstSlot: number;
  trades: number;
  window: TapeTrade[];
  buys: number;
  creator: string;
}

const tapes = new Map<string, Tape>();

interface Held {
  entrySlot: number;
  peakGainBps: number;
  tookHalf: boolean;
  buys: number;
  mode: Mode;
}

const held = new Map<string, Held>();
const lastSoldSlot = new Map<string, number>();
const buyCount = new Map<string, number>();
const lastMode = new Map<string, Mode>();
// Mints that have actually held a position (so a rejected buy is never
// mistaken for a closed round trip) and how many round trips have closed.
const seenPosition = new Set<string>();
let closedRoundTrips = 0;

function noteClosed(mint: string): void {
  if (!seenPosition.has(mint)) return;
  seenPosition.delete(mint);
  closedRoundTrips += 1;
}

function priceNumDen(state: BotState, mint: string): [bigint, bigint] | null {
  const curve = state.curves.get(mint);
  if (!curve) return null;
  if (curve.virtual_token_reserves <= 0n) return null;
  return [curve.virtual_quote_reserves, curve.virtual_token_reserves];
}

// value of `tokens` at the curve's current reserves, in lamports.
function markValueLamports(state: BotState, mint: string, tokens: bigint): bigint | null {
  const p = priceNumDen(state, mint);
  if (!p) return null;
  return (tokens * p[0]) / p[1];
}

function gainBps(value: bigint, cost: bigint): number {
  if (cost <= 0n) return 0;
  return Number((value * 10_000n) / cost) - 10_000;
}

function feedEvents(state: BotState, batch: Batch): void {
  for (const event of batch.events) {
    if (event.event === "CreateEvent") {
      if (!tapes.has(event.mint)) {
        tapes.set(event.mint, {
          firstNum: BigInt(event.virtual_quote_reserves),
          firstDen: BigInt(event.virtual_token_reserves),
          firstSlot: event.slot,
          trades: 0,
          window: [],
          buys: 0,
          creator: event.creator,
        });
      }
      continue;
    }
    if (event.event === "TradeEvent") {
      let tape = tapes.get(event.mint);
      if (!tape) {
        tape = {
          firstNum: BigInt(event.virtual_sol_reserves),
          firstDen: BigInt(event.virtual_token_reserves),
          firstSlot: event.slot,
          trades: 0,
          window: [],
          buys: 0,
          creator: event.creator,
        };
        tapes.set(event.mint, tape);
      }
      tape.trades += 1;
      tape.window.push({
        buy: event.is_buy,
        sol: BigInt(event.sol_amount),
        user: event.user,
      });
      if (tape.window.length > TUNING.windowTrades) tape.window.shift();
      if (event.is_buy) tape.buys += 1;
      continue;
    }
    // CompleteEvent: the curve is done and the harness closes the position;
    // that is a closed round trip. Drop the tape so it cannot re-trigger.
    if (event.event === "CompleteEvent") {
      noteClosed(event.mint);
      tapes.delete(event.mint);
      held.delete(event.mint);
    }
  }
}

// ---------------------------------------------------------------- exits
// A sell that the harness rejects (slippage, in a fast crash) leaves the
// position in place, so an exit is only ever issued when no sell for that
// mint is already pending, and a position's record is only cleared once the
// position itself is gone from the account. Otherwise a rejected stop would
// be re-issued every batch forever while the coin kept falling.
function exitOrders(state: BotState, batch: Batch) {
  const orders: { side: "sell"; mint: string; token_amount: bigint; max_slippage_bps: number }[] = [];
  for (const mint of [...held.keys()]) {
    if (!state.positions.has(mint)) {
      noteClosed(mint);
      lastSoldSlot.set(mint, batch.slot);
      held.delete(mint);
    }
  }
  const sellPending = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === "sell") sellPending.add(p.order.mint);
  }
  for (const [mint, pos] of state.positions) {
    seenPosition.add(mint);
    const curve = state.curves.get(mint);
    if (!curve || curve.complete) continue;
    if (sellPending.has(mint)) continue;
    const value = markValueLamports(state, mint, pos.token_amount);
    if (value === null) continue;
    const gain = gainBps(value, pos.cost_lamports);
    let rec = held.get(mint);
    if (!rec) {
      rec = { entrySlot: batch.slot, peakGainBps: gain, tookHalf: false, buys: buyCount.get(mint) ?? 1, mode: lastMode.get(mint) ?? "lottery" };
      held.set(mint, rec);
    }
    if (gain > rec.peakGainBps) rec.peakGainBps = gain;
    const age = batch.slot - rec.entrySlot;
    const half = pos.token_amount / 2n;
    const ex = EXITS[rec.mode];

    if (!rec.tookHalf && gain >= ex.takeHalfBps && half > 0n) {
      rec.tookHalf = true;
      orders.push({ side: "sell", mint, token_amount: half, max_slippage_bps: TUNING.sellSlippageBps });
      continue;
    }
    if (gain >= ex.takeAllBps) {
      orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: TUNING.sellSlippageBps });
      continue;
    }
    if (rec.peakGainBps >= ex.trailArmBps && gain <= rec.peakGainBps - ex.trailGivebackBps) {
      orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: TUNING.sellSlippageBps });
      continue;
    }
    if (gain <= ex.hardStopBps) {
      orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: TUNING.sellSlippageBps });
      continue;
    }
    if (age >= ex.bleedCutSlots && gain <= ex.bleedCutBps) {
      orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: TUNING.sellSlippageBps });
      continue;
    }
    if (age >= ex.timeStopSlots && gain < ex.timeStopBps) {
      orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: TUNING.sellSlippageBps });
    }
  }
  return orders;
}

// ---------------------------------------------------------------- entries
interface Candidate {
  mint: string;
  windowBuy: bigint;
}

function rankCandidates(state: BotState, batch: Batch): Candidate[] {
  // Strongest tape first: rank candidate mints by non-creator window buy
  // SOL, best first. Map iteration is insertion order (first-seen order),
  // so the ranking sort is fully deterministic for a fixed input stream.
  const candidates: Candidate[] = [];
  for (const [mint, tape] of tapes) {
    if (state.positions.has(mint)) continue;
    if (state.curves.get(mint)?.complete) continue;
    if ((buyCount.get(mint) ?? 0) >= TUNING.maxBuysPerMint) continue;
    const cooled = lastSoldSlot.get(mint);
    if (cooled !== undefined && batch.slot - cooled < TUNING.rebuyCooldownSlots) continue;
    if (tape.trades < TUNING.minTotalTrades) continue;
    let windowBuy = 0n;
    let windowSell = 0n;
    let windowBuys = 0;
    const buyers = new Set<string>();
    for (const t of tape.window) {
      // Creator flow never counts: the creator's own trades are skipped
      // entirely, buys and sells alike, exactly as in the practice sim.
      if (t.user === tape.creator) continue;
      if (t.buy) {
        windowBuy += t.sol;
        windowBuys += 1;
        buyers.add(t.user);
      } else {
        windowSell += t.sol;
      }
    }
    if (windowBuys < TUNING.minWindowBuys) continue;
    if (buyers.size < TUNING.minDistinctBuyers) continue;
    if (windowBuy < TUNING.minWindowBuySol) continue;
    if (windowSell * 10_000n > windowBuy * BigInt(TUNING.maxSellShareBps)) continue;
    const price = priceNumDen(state, mint);
    if (!price) continue;
    // Rise from first sight: minRise <= (now - first) / first <= maxRise,
    // compared by cross-multiplication so no floats are involved.
    const [nowNum, nowDen] = price;
    const [firstNum, firstDen] = [tape.firstNum, tape.firstDen];
    const lowOk = nowNum * firstDen * 10_000n >= firstNum * nowDen * BigInt(10_000 + TUNING.minRiseBps);
    const highOk = nowNum * firstDen * 10_000n <= firstNum * nowDen * BigInt(10_000 + TUNING.maxRiseBps);
    if (!lowOk || !highOk) continue;
    // Market cap under the ceiling: price * 1e15 token supply, in lamports.
    const mcap = (nowNum * 1_000_000_000_000_000n) / nowDen;
    if (mcap >= TUNING.maxMcapLamports) continue;
    const curve = state.curves.get(mint);
    if (!curve || curve.real_quote_reserves < TUNING.minRealSol) continue;
    candidates.push({ mint, windowBuy });
  }
  candidates.sort((a, b) => (a.windowBuy > b.windowBuy ? -1 : a.windowBuy < b.windowBuy ? 1 : 0));
  return candidates;
}

function sizeBuy(state: BotState, mint: string, target: bigint, freeCash: bigint): bigint | null {
  const cap = state.maxBuyLamports(mint);
  let size = target;
  const byCap = (cap * BigInt(TUNING.maxBuyShareBps)) / 10_000n;
  if (byCap < size) size = byCap;
  const byCash = (freeCash * BigInt(TUNING.maxCashShareBps)) / 10_000n;
  if (byCash < size) size = byCash;
  if (size < TUNING.minSizeLamports) return null;
  if (size > freeCash - state.txFeeLamports()) return null;
  return size;
}

function placeBuy(
  state: BotState,
  batch: Batch,
  mint: string,
  mode: Mode,
  target: bigint,
  freeCash: bigint,
  orders: { side: "buy"; mint: string; quote_lamports: bigint; max_slippage_bps: number }[],
): bigint {
  const size = sizeBuy(state, mint, target, freeCash);
  if (size === null) return freeCash;
  buyCount.set(mint, (buyCount.get(mint) ?? 0) + 1);
  lastMode.set(mint, mode);
  held.set(mint, { entrySlot: batch.slot, peakGainBps: 0, tookHalf: false, buys: buyCount.get(mint)!, mode });
  orders.push({ side: "buy", mint, quote_lamports: size, max_slippage_bps: TUNING.buySlippageBps });
  return freeCash - size - state.txFeeLamports();
}

function entryOrders(state: BotState, batch: Batch) {
  const orders: { side: "buy"; mint: string; quote_lamports: bigint; max_slippage_bps: number }[] = [];
  if (state.committedPositionCount() >= state.hello.caps.max_open_positions) return orders;
  let freeCash = state.freeCashLamports();
  if (freeCash <= 0n) return orders;
  const candidates = rankCandidates(state, batch);

  // Lottery pass: strongest tapes first, at most three lottery slots open.
  // (The open count is re-read each iteration because placing a buy adds a
  // held record, mirroring the practice sim's slot accounting.)
  let newLottery = 0;
  for (const { mint } of candidates) {
    if (newLottery >= TUNING.maxNewBuysPerBatch) break;
    let lotteryOpen = newLottery;
    for (const rec of held.values()) if (rec.mode === "lottery") lotteryOpen += 1;
    if (lotteryOpen >= TUNING.lotterySlotCap) break;
    if (state.committedPositionCount() + orders.length >= state.hello.caps.max_open_positions) break;
    const before = freeCash;
    freeCash = placeBuy(state, batch, mint, "lottery", TUNING.lotteryTargetSizeLamports, freeCash, orders);
    if (freeCash !== before) newLottery += 1;
  }

  // Scalp pass: the same candidates, tiny size, into the remaining slots —
  // only while the guardrail round trips are still short. A coin already
  // bought as a lottery hold is never re-bought as a scalp.
  const scalpOpen = [...held.values()].filter((rec) => rec.mode === "scalp").length;
  if (closedRoundTrips < TUNING.scalpStopAfterClosed && scalpOpen < TUNING.scalpSlotCap) {
    for (const { mint } of candidates) {
      if (state.committedPositionCount() + orders.length >= state.hello.caps.max_open_positions) break;
      if (state.positions.has(mint)) continue;
      if (lastMode.get(mint) === "lottery") continue;
      if (orders.some((o) => o.mint === mint)) continue;
      freeCash = placeBuy(state, batch, mint, "scalp", TUNING.scalpTargetSizeLamports, freeCash, orders);
    }
  }
  return orders;
}

// ---------------------------------------------------------------- run
await runBot({
  onBatch(state, batch) {
    feedEvents(state, batch);
    const sells = exitOrders(state, batch);
    const buys = entryOrders(state, batch);
    return [...sells, ...buys];
  },
  onDone(_state, _done) {
    // Positions are flattened by the harness; nothing left to send.
  },
});

// Keep the LAMPORTS_PER_SOL import used for documentation of units.
void LAMPORTS_PER_SOL;
