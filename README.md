# Reflex

**A Solana transaction stack with reflexes.** It watches the network over a live stream,
learns from every bundle it sends, and adapts its tip, timing, and retries to land
transactions reliably.

Under the hood: live Yellowstone/Geyser streaming, Jito bundle submission, full lifecycle
tracking across commitment levels, and an AI agent that owns one real operational decision
autonomously (**Autonomous Retry with Fault Injection**).

Built for the *Advanced Infrastructure Challenge – Build a Smart Transaction Stack* bounty.

> **Network note:** Jito bundles run on **mainnet** (Jito does not operate on devnet). Real
> bundle submissions and lifecycle logs are from mainnet, so every slot number can be
> cross-referenced on an explorer. `npm run report` does that cross-referencing for you.

---

## What makes this different

Most submissions hardcode a tip and call an `if/else` an "AI agent." This one is a closed
feedback loop:

- **The agent learns from the system's own behavior.** Every submission records the tip, the
  network conditions, and whether it landed and how fast. The agent estimates landing
  probability from *your measured* per-tip-bucket history (`agent/telemetry.ts`) and picks the
  cheapest tip that hits the target — not a constant.
- **A live network-health signal** (`health.ts`) turns README Q1 into a real control input:
  slot-skip rate, median processed→confirmed delta, and tip-floor slope produce a
  calm/normal/congested regime the agent reacts to.
- **Visible reasoning.** Every decision logs the alternatives it rejected and why
  (`logs/agent-decisions.jsonl`).
- **Real guardrails.** Schema validation, a hard tip ceiling, bounded retries, and a
  deterministic fallback so the agent is safe and never breaks (runs with zero API key).
- **Self-verifying logs.** `npm run report` fetches each landed slot's leader from the chain.

---

## Architecture (three clean layers)

| Layer | Responsibility | Key files |
|-------|----------------|-----------|
| **Stream** (eyes) | Yellowstone gRPC: slot status + signer's transactions. Reconnect + backpressure. | `src/stream/*` |
| **Core tx stack** (hands) | Bundle build + submit, lifecycle tracking, failure classification, live tip data. | `src/jito/*`, `src/lifecycle.ts` |
| **AI layer** (brain) | Consumes observations only; returns a structured decision with visible reasoning. | `src/agent/*` |

Pipeline (`src/pipeline.ts`) wires all three into the autonomous retry loop. The full
architecture write-up (judged separately) is in `ARCHITECTURE.md` — publish it to
Notion/Docs/Figma and link it in your submission.

## Project structure

```
src/
  config.ts            constants + env (endpoints, tip accounts fallback)
  smoke.ts             [run] live tip floor + tip accounts (zero infra)
  genkey.ts            [run] generate a throwaway keypair
  wallet.ts            load signer from env
  tipPolicy.ts         baseline tip seam (superseded by the agent)
  lifecycle.ts         lifecycle record + stage timestamps + latency deltas
  health.ts            network-health regime from the stream (README Q1 signal)
  bundle-run.ts        [run] submit one bundle, poll-confirm, log it
  pipeline.ts          [run] integrated agent + stream-confirm + autonomous retry
  chaos.ts             [run] deterministic fault-injection suite (offline)
  agent-demo.ts        [run] one agent decision with counterfactuals
  stream.ts            [run] live slot/health verifier
  report.ts            [run] self-verifying report (fetches slot leaders)
  jito/
    tipFloor.ts        live tip percentiles -> lamports
    tipAccounts.ts     getTipAccounts (+ fallback) + random pick
    bundle.ts          build / sendBundle / getBundleStatuses
    failures.ts        failure classifier
  agent/
    types.ts           context + decision schema
    llm.ts             provider-agnostic LLM client (GitHub Models impl)
    telemetry.ts       learned landing rate per tip bucket (from logs)
    agent.ts           reasoning core + guardrails + deterministic fallback
  stream/
    yellowstone.ts     resilient gRPC subscriber (reconnect + backpressure + ping)
    slotClock.ts       per-slot commitment timeline + waitFor()
    confirm.ts         stream-based landing confirmation
```

## Scripts — what each needs

| Command | What it does | Needs |
|---------|--------------|-------|
| `npm run smoke` | live tip floor + tip accounts | nothing |
| `npm run chaos` | drives the agent through every failure mode | nothing (LLM optional) |
| `npm run agent` | one agent decision with counterfactuals | nothing (LLM optional) |
| `npm run genkey` | generate a keypair | nothing |
| `npm run bundle` | submit ONE bundle, poll-confirm, log | funded wallet |
| `npm run pipeline` | full agent + autonomous retry loop | funded wallet (+ gRPC for stream confirm) |
| `npm run stream` | live slot status + health verifier | gRPC endpoint |
| `npm run report` | verify logged slots against the chain | RPC (after some runs) |

---

## Setup & run guide

```bash
npm install
cp .env.example .env
```

### Phase 1 — runs today, zero infrastructure
```bash
npm run smoke     # live Jito tip floor + tip accounts
npm run chaos     # agent reasons through 5 failure/condition scenarios
npm run agent     # a single reasoned decision with rejected alternatives
```
Set `GITHUB_MODELS_API_KEY` in `.env` to put the LLM in the loop; otherwise the deterministic
fallback runs (still produces real decisions + counterfactuals).

### Phase 2 — wallet only (your first real, explorer-verifiable bundle)
```bash
npm run genkey                      # put the secret in SIGNER_SECRET_KEY, fund the pubkey ~0.05 SOL
npm run bundle                      # one bundle, polled confirmation
npm run pipeline                    # the full agent retry loop (poll confirmation)
INJECT_EXPIRY=1 npm run pipeline    # simulate a blockhash-expiry failure and watch the agent recover
npm run report                      # cross-reference your landed slots on-chain
```

### Phase 3 — full stack (with a Yellowstone gRPC endpoint)
Put `GRPC_URL` + `GRPC_TOKEN` in `.env` (SolInfra credits via the bounty sponsor, or a
QuickNode/Shyft trial). Then:
```bash
npm run stream      # verify slots tick through processed -> confirmed -> finalized
npm run pipeline    # now confirms landing via the STREAM, not polling
```

### Producing the required lifecycle log
Run `npm run pipeline` ~10+ times (use `INJECT_EXPIRY=1` for at least two failure cases).
Each run appends to `logs/lifecycle.jsonl` and `logs/agent-decisions.jsonl`. Then
`npm run report` prints a verifiable summary. Paste that into your submission.

### Environment variables
```
GRPC_URL, GRPC_TOKEN        Yellowstone gRPC endpoint (Phase 3)
RPC_URL                     mainnet RPC for reads + polling (free tier fine)
SIGNER_SECRET_KEY           base58 secret of a funded throwaway wallet
GITHUB_MODELS_API_KEY       optional; enables the LLM reasoning path
GITHUB_MODEL                default gpt-4o
MAX_ATTEMPTS                retry cap (default 4)
MAX_TIP_LAMPORTS            hard tip ceiling (default 200000)
TARGET_LANDING_PROB         agent target (default 0.8)
INJECT_EXPIRY=1             simulate a blockhash-expiry failure in the pipeline
```

---

## README questions (the bounty requires answering these)

These have specific correct answers. The notes are correct; **replace the `[from your logs]`
placeholders with real observations from your runs** — observation-backed answers score highest.

### Q1 — `processed_at` → `confirmed_at` delta and network health
It is consensus / vote-propagation latency. `processed` = the tx is in a block one validator
produced; `confirmed` = a supermajority (~66% of stake) has voted on that block. A small, tight
delta means votes propagate fast and validators are in sync — a healthy cluster. A large or
growing delta signals stress: vote lag, fork activity, or congestion. (This stack computes it
live in `health.ts` and exposes it via `npm run stream`.)

*From my logs:* `[median delta during calm vs busy periods]`

### Q2 — why never `finalized` for a time-sensitive blockhash
A blockhash is valid for only ~150 slots (~60–90s) before it expires. `finalized` refers to a
block already ~32+ slots old, so you start with a big chunk of the window spent, sharply raising
expiry risk. Use `confirmed`: recent enough to keep almost the full window, but voted-on so it
isn't on a fork that gets dropped (the `processed` risk). This stack fetches blockhashes at
`confirmed`.

*From my logs:* `[validity headroom: confirmed vs finalized blockhash]`

### Q3 — what happens if the Jito leader skips their slot
The bundle isn't included — full stop. Bundles route to the block engine for a specific upcoming
Jito leader; if that leader skips, the bundle is dropped for that window, no tip is charged
(tips pay only on inclusion), and nothing lands. Jito txs use the private block-engine path, not
gossip, so there is no fallback — you must resubmit targeting the next Jito leader, refreshing
the blockhash if it expired.

*From my logs:* `[a submission that missed its window and was re-targeted]`
