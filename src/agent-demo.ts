/**
 * Agent reasoning demo. Run: `npm run agent`
 *
 * Zero infrastructure required. Pulls the LIVE tip floor, loads any learned telemetry from
 * logs/lifecycle.jsonl, builds a context, and prints the agent's decision WITH the
 * alternatives it rejected and why. Runs on the deterministic fallback with no API key; if
 * ANTHROPIC_API_KEY is set, the LLM reasons over the same context.
 *
 * Health is stubbed here as a sample; the stream layer (next infra milestone) computes it
 * live from slot data.
 */
import { getTipFloor } from './jito/tipFloor.js';
import { JITO_MIN_TIP_LAMPORTS, LAMPORTS_PER_SOL } from './config.js';
import { loadTelemetry } from './agent/telemetry.js';
import { decide } from './agent/agent.js';
import { GithubModelsLlm, LlmClient } from './agent/llm.js';
import { AgentContext, NetworkHealth } from './agent/types.js';

async function main() {
  const floor = await getTipFloor();

  // Sample health (the stream layer fills this in for real).
  const health: NetworkHealth = {
    slotSkipRate: 0.03,
    medianProcessedToConfirmedMs: 520,
    tipFloorSlope: 0,
    regime: 'normal',
  };

  const context: AgentContext = {
    tipFloor: {
      p25: floor.p25,
      p50: floor.p50,
      p75: floor.p75,
      p95: floor.p95,
      p99: floor.p99,
      ema50: floor.ema50,
    },
    health,
    history: [], // first attempt; the chaos harness will populate failures
    telemetry: loadTelemetry(),
    constraints: {
      minTipLamports: JITO_MIN_TIP_LAMPORTS,
      maxTipLamports: 200_000,
      maxAttempts: 4,
      targetLandingProb: 0.8,
    },
  };

  const apiKey = process.env.GITHUB_MODELS_API_KEY;
  const llm: LlmClient | null = apiKey ? new GithubModelsLlm(apiKey) : null;
  console.log(`Reasoning core: ${llm ? llm.name : 'deterministic fallback (no API key)'}\n`);

  const decision = await decide(context, llm);

  const sol = (l: number) => (l / LAMPORTS_PER_SOL).toFixed(9);
  console.log('DECISION');
  console.log(`  action     : ${decision.action}`);
  console.log(`  tip        : ${decision.tipLamports} lamports (${sol(decision.tipLamports)} SOL)`);
  console.log(`  confidence : ${decision.confidence}`);
  console.log(`  source     : ${decision.source}`);
  console.log(`  rationale  : ${decision.rationale}`);
  console.log('\n  considered alternatives:');
  for (const a of decision.consideredAlternatives) {
    console.log(
      `    - ${a.option.padEnd(4)} ${String(a.tipLamports).padStart(8)} lamports  ` +
        `landing~${Math.round(a.projectedLandingProb * 100)}%` +
        (a.rejectedReason ? `  rejected: ${a.rejectedReason}` : '  ← chosen'),
    );
  }
  console.log('\n  telemetry buckets used:', context.telemetry.length ? context.telemetry : '(none yet — run some bundles to teach it)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
