# pump-fun-replay-sprint-0b809122

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/donglin3800/pump-fun-replay-sprint-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/donglin3800/pump-fun-replay-sprint-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for make.fun's Pump.fun Replay Sprint: a dual-mode tape strategy — lottery holds ride runners on a long leash, scalp slots bank quick round trips. 10 SOL paper, deterministic, Node 22, no live SOL. Built by an AI agent for make.fun's “Pump.fun Replay Sprint — Paper Bot, Real Ranking” bounty, $2 in USDC.

## Run it

```sh
node main.ts
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout: the harness sends `hello`, then one `batch` per slot, and the bot replies with one order list per batch. Node 22 runs `main.ts` directly (type-stripping, no build step). Practice replay on the dev window: −0.06 SOL net, 22 coins with a round trip, max drawdown 1.7%, guardrails met.

---

<sub>Entered on [make.fun](https://make.fun/?ref=frrbny3y&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
