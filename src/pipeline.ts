/**
 * Integrated smart-submit pipeline — the full "Autonomous Retry with Fault Injection" loop.
 * Run: `npm run pipeline`            (set INJECT_EXPIRY=1 to simulate a blockhash-expiry failure)
 *
 * Each attempt: the agent reasons over live conditions + prior failures and decides the tip;
 * we submit; we confirm via the STREAM (if GRPC_URL is set) or by polling (wallet-only mode);
 * on failure the agent reasons again, the blockhash is refreshed, the tip recalculated, and it
 * resubmits — autonomously. Nothing about the retry is hardcoded.
 */
import { Connection } from '@solana/web3.js';
import { mkdirSync, appendFileSync } from 'node:fs';
import {
  RPC_URL,
  GRPC_URL,
  GRPC_TOKEN,
  JITO_MIN_TIP_LAMPORTS,
  LAMPORTS_PER_SOL,
} from './config.js';
import { loadSigner } from './wallet.js';
import { getTipFloor } from './jito/tipFloor.js';
import { getTipAccounts, pickTipAccount } from './jito/tipAccounts.js';
import {
  buildSelfTransferBundleTx,
  sendBundle,
  getBundleStatuses,
  getInflightBundleStatuses,
} from './jito/bundle.js';
import { decide } from './agent/agent.js';
import { GithubModelsLlm, LlmClient } from './agent/llm.js';
import { loadTelemetry } from './agent/telemetry.js';
import { AgentContext, AttemptRecord, AgentDecision } from './agent/types.js';
import { newRecord, mark, LifecycleRecord } from './lifecycle.js';
import { YellowstoneStream } from './stream/yellowstone.js';
import { SlotClock } from './stream/slotClock.js';
import { LifecycleConfirmer } from './stream/confirm.js';
import { HealthMonitor, neutralHealth } from './health.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sol = (l: number) => (l / LAMPORTS_PER_SOL).toFixed(9);

interface Outcome {
  landedSlot: number;
  processedAt: number;
  confirmedAt: number | null;
  finalizedAt: number | null;
}

async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');
  const signer = loadSigner();
  const maxAttempts = Number(process.env.MAX_ATTEMPTS ?? 4);
  const injectExpiry = process.env.INJECT_EXPIRY === '1';

  const apiKey = process.env.GITHUB_MODELS_API_KEY;
  const llm: LlmClient | null = apiKey ? new GithubModelsLlm(apiKey) : null;
  console.log(`Signer        : ${signer.publicKey.toBase58()}`);
  console.log(`Reasoning core: ${llm ? llm.name : 'deterministic fallback'}`);

  // Optional stream-based confirmation + health (used when a gRPC endpoint is configured).
  let confirmer: LifecycleConfirmer | null = null;
  let health: HealthMonitor | null = null;
  let stream: YellowstoneStream | null = null;
  if (GRPC_URL) {
    const clock = new SlotClock();
    health = new HealthMonitor(clock);
    stream = new YellowstoneStream({
      endpoint: GRPC_URL,
      token: GRPC_TOKEN || undefined,
      watchAccounts: [signer.publicKey.toBase58()],
    });
    confirmer = new LifecycleConfirmer(stream, clock);
    void stream.start();
    console.log('Confirmation  : Yellowstone stream');
    await sleep(3000); // warm up the slot clock
  } else {
    console.log('Confirmation  : RPC polling (set GRPC_URL for stream confirmation)');
  }

  const constraints = {
    minTipLamports: JITO_MIN_TIP_LAMPORTS,
    maxTipLamports: Number(process.env.MAX_TIP_LAMPORTS ?? 200_000),
    maxAttempts,
    targetLandingProb: Number(process.env.TARGET_LANDING_PROB ?? 0.8),
  };

  const attempts: AttemptRecord[] = [];
  let result: LifecycleRecord | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const floor = await getTipFloor();
    health?.recordTipFloorSample(floor.p50);

    const ctx: AgentContext = {
      tipFloor: { p25: floor.p25, p50: floor.p50, p75: floor.p75, p95: floor.p95, p99: floor.p99, ema50: floor.ema50 },
      health: health ? health.snapshot() : neutralHealth(),
      history: attempts,
      telemetry: loadTelemetry(),
      constraints,
    };

    const decision = await decide(ctx, llm);
    logDecision(attempt, decision, ctx);
    printDecision(attempt, decision);

    if (decision.action === 'hold') {
      console.log('  → holding; waiting before re-evaluating conditions');
      await sleep(3000);
      continue;
    }

    // Fault injection: simulate a blockhash-expiry failure before the first real send.
    if (injectExpiry && attempt === 1) {
      console.log('  🧪 FAULT INJECTED: simulated blockhash expiry — no submission this attempt');
      attempts.push({ attempt, tipLamports: decision.tipLamports, failure: 'expired_blockhash', landedSlot: null });
      continue;
    }

    const priorWasExpiry = attempts.some((a) => a.failure === 'expired_blockhash');
    if (priorWasExpiry) console.log('  ↻ refreshing blockhash after prior expiry');

    const accounts = await getTipAccounts();
    const tipAccount = pickTipAccount(accounts);
    const built = await buildSelfTransferBundleTx({
      conn,
      signer,
      tipAccount,
      tipLamports: decision.tipLamports,
    });
    const rec = newRecord(built.signature, decision.tipLamports, decision.rationale);
    rec.bundleId = null;

    if (confirmer) confirmer.watch(built.signature).catch(() => {}); // start watching before submit

    const bundleId = await sendBundle([built.tx]);
    rec.bundleId = bundleId;
    console.log(`  submitted sig=${built.signature} bundle=${bundleId} tip=${decision.tipLamports}`);

    try {
      const outcome = confirmer
        ? await confirmViaStream(confirmer, conn, built.signature, built.lastValidBlockHeight)
        : await confirmViaPolling(conn, bundleId, built.lastValidBlockHeight);

      mark(rec, 'processed', outcome.processedAt);
      if (outcome.confirmedAt != null) mark(rec, 'confirmed', outcome.confirmedAt);
      if (outcome.finalizedAt != null) mark(rec, 'finalized', outcome.finalizedAt);
      rec.landedSlot = outcome.landedSlot;
      result = rec;
      break;
    } catch (err) {
      const failure = parseFailure((err as Error).message);
      rec.failure = failure;
      attempts.push({ attempt, tipLamports: decision.tipLamports, failure, landedSlot: null });
      writeLifecycle(rec);
      console.log(`  ✗ attempt ${attempt} failed: ${failure} — agent will reason and retry`);
    }
  }

  mkdirSync('logs', { recursive: true });
  if (result) {
    writeLifecycle(result);
    console.log(`\n✅ LANDED in slot ${result.landedSlot} after ${attempts.length + 1} attempt(s)`);
    console.log(`   verify: https://solscan.io/tx/${result.signature}`);
    console.log('   latency deltas (ms):', result.deltasMs);
  } else {
    console.log(`\n❌ exhausted ${maxAttempts} attempts without landing`);
    console.log('   attempt history:', attempts);
  }

  stream?.stop();
  process.exit(result ? 0 : 1);
}

function printDecision(attempt: number, d: AgentDecision): void {
  console.log(`\nATTEMPT ${attempt} — agent decision (${d.source})`);
  console.log(`  action=${d.action} tip=${d.tipLamports} lamports (${sol(d.tipLamports)} SOL) confidence=${d.confidence}`);
  console.log(`  rationale: ${d.rationale}`);
  for (const a of d.consideredAlternatives) {
    console.log(
      `    - ${a.option.padEnd(4)} ${String(a.tipLamports).padStart(8)} lamports  landing~${Math.round(a.projectedLandingProb * 100)}%` +
        (a.rejectedReason ? `  rejected: ${a.rejectedReason}` : '  ← chosen'),
    );
  }
}

function logDecision(attempt: number, d: AgentDecision, ctx: AgentContext): void {
  mkdirSync('logs', { recursive: true });
  appendFileSync(
    'logs/agent-decisions.jsonl',
    JSON.stringify({
      ts: new Date().toISOString(),
      attempt,
      regime: ctx.health.regime,
      tipFloorP50: ctx.tipFloor.p50,
      decision: d,
      priorFailures: ctx.history.map((h) => h.failure),
    }) + '\n',
  );
}

function writeLifecycle(rec: LifecycleRecord): void {
  mkdirSync('logs', { recursive: true });
  appendFileSync('logs/lifecycle.jsonl', JSON.stringify(rec) + '\n');
}

function parseFailure(message: string): string {
  if (message.startsWith('expired_blockhash')) return 'expired_blockhash';
  if (message.startsWith('bundle_failure')) return 'bundle_failure';
  if (message.includes('timeout')) return 'not_landed';
  return 'not_landed';
}

async function confirmViaStream(
  confirmer: LifecycleConfirmer,
  conn: Connection,
  signature: string,
  lastValidBlockHeight: number,
): Promise<Outcome> {
  let stop = false;
  const watch = confirmer.watch(signature, true);
  watch.catch(() => {});
  const expiryGuard = (async (): Promise<never> => {
    while (!stop) {
      const h = await conn.getBlockHeight('confirmed');
      if (h > lastValidBlockHeight) {
        confirmer.abandon(signature, 'expired_blockhash');
        throw new Error('expired_blockhash');
      }
      await sleep(1500);
    }
    throw new Error('aborted');
  })();
  try {
    const c = await Promise.race([watch, expiryGuard]);
    return { landedSlot: c.landedSlot, processedAt: c.processedAt, confirmedAt: c.confirmedAt, finalizedAt: c.finalizedAt };
  } finally {
    stop = true;
  }
}

async function confirmViaPolling(
  conn: Connection,
  bundleId: string,
  lastValidBlockHeight: number,
): Promise<Outcome> {
  while (true) {
    const status = await getBundleStatuses(bundleId);
    if (status?.confirmation_status) {
      if (status.err) throw new Error(`bundle_failure:${JSON.stringify(status.err)}`);
      if (status.confirmation_status === 'confirmed' || status.confirmation_status === 'finalized') {
        const now = Date.now();
        return { landedSlot: status.slot, processedAt: now, confirmedAt: now, finalizedAt: null };
      }
    }
    const height = await conn.getBlockHeight('confirmed');
    if (height > lastValidBlockHeight) {
      const inflight = await getInflightBundleStatuses(bundleId);
      throw new Error(`expired_blockhash:${inflight?.status ?? 'unknown'}`);
    }
    await sleep(1000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
