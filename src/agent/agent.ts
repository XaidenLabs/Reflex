import {
  AgentContext,
  AgentDecision,
  ConsideredAlternative,
} from './types.js';
import { LlmClient } from './llm.js';
import { bucketFor } from './telemetry.js';

const SYSTEM_PROMPT = `You are the operational decision agent inside a Solana Jito bundle stack.
You own the SUBMISSION STRATEGY decision (autonomous retry with fault injection): on each
attempt, decide the tip in lamports and whether to submit now or hold.

Reason over:
- the live Jito tip floor percentiles,
- the network health regime (calm/normal/congested) and its signals,
- this submission's prior attempts and their failure classes,
- the measured landing telemetry (the system's own observed landing rate per tip bucket).

Principles:
- Choose the CHEAPEST tip that meets the target landing probability. Tips are a cost.
- If a prior attempt failed as 'fee_too_low', raise the tip. If 'expired_blockhash', the
  blockhash will be refreshed by the caller; keep the tip unless conditions changed.
- If the regime is 'congested' and rising, lean toward higher percentiles; if 'calm', lower.
- NEVER exceed constraints.maxTipLamports. NEVER go below constraints.minTipLamports.
- Hold (action:"hold") only if submitting now would be wasteful (e.g. tip needed to hit the
  target exceeds the ceiling) — otherwise submit.

Return ONLY a JSON object, no prose, with this exact shape:
{
  "action": "submit" | "hold",
  "tipLamports": <integer>,
  "rationale": "<one or two sentences>",
  "consideredAlternatives": [
    {"option":"<name>","tipLamports":<int>,"projectedLandingProb":<0..1>,"projectedCostLamports":<int>,"rejectedReason":"<why not>"}
  ],
  "confidence": <0..1>
}`;

/** Run the agent. Pass llm=null to use the deterministic fallback (no API key needed). */
export async function decide(
  context: AgentContext,
  llm: LlmClient | null,
): Promise<AgentDecision> {
  if (llm) {
    try {
      const raw = await llm.reason(SYSTEM_PROMPT, context);
      const validated = validate(raw, context);
      return { ...validated, source: 'llm' };
    } catch (err) {
      console.warn(
        `[agent] LLM path failed (${(err as Error).message}); using deterministic fallback`,
      );
    }
  }
  return { ...heuristic(context), source: 'heuristic-fallback' };
}

/** Validate + guardrail an untrusted model decision. Throws if unusable so we can fall back. */
function validate(raw: Record<string, unknown>, ctx: AgentContext): Omit<AgentDecision, 'source'> {
  const action = raw.action === 'hold' ? 'hold' : 'submit';
  const tipRaw = Number(raw.tipLamports);
  if (!Number.isFinite(tipRaw)) throw new Error('model returned no usable tipLamports');

  const tipLamports = clampTip(Math.round(tipRaw), ctx);
  const rationale = typeof raw.rationale === 'string' ? raw.rationale : '(no rationale provided)';
  const confidence = clamp01(Number(raw.confidence));
  const consideredAlternatives = Array.isArray(raw.consideredAlternatives)
    ? (raw.consideredAlternatives as ConsideredAlternative[])
    : [];

  return { action, tipLamports, rationale, consideredAlternatives, confidence };
}

function clampTip(tip: number, ctx: AgentContext): number {
  const { minTipLamports, maxTipLamports } = ctx.constraints;
  return Math.max(minTipLamports, Math.min(maxTipLamports, tip));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/**
 * Deterministic fallback. Produces a real, defensible decision with counterfactuals using
 * the measured telemetry and current conditions — so the system works with zero API key and
 * the guardrail path is always exercisable.
 */
function heuristic(ctx: AgentContext): Omit<AgentDecision, 'source'> {
  const { tipFloor, health, history, constraints } = ctx;

  // Candidate tips keyed on percentiles, biased by regime.
  const candidates: Array<{ option: string; tip: number }> = [
    { option: 'p25', tip: tipFloor.p25 },
    { option: 'p50', tip: tipFloor.p50 },
    { option: 'p75', tip: tipFloor.p75 },
    { option: 'p95', tip: tipFloor.p95 },
  ];

  // If we already failed as fee_too_low, drop the cheap candidates.
  const failedFeeLow = history.some((h) => h.failure === 'fee_too_low');
  const filtered = failedFeeLow ? candidates.filter((c) => c.tip >= tipFloor.p75) : candidates;

  const alts: ConsideredAlternative[] = filtered.map((c) => {
    const tip = clampTip(c.tip, ctx);
    return {
      option: c.option,
      tipLamports: tip,
      projectedLandingProb: landingProb(c.option, tip, ctx),
      projectedCostLamports: tip,
      rejectedReason: '',
    };
  });

  // Cheapest candidate that meets the target; if none meet it, the one with the highest
  // landing probability (ties broken by cheaper tip) — never the cheapest-and-weakest.
  const EPS = 1e-9;
  const meeting = alts.filter((a) => a.projectedLandingProb >= constraints.targetLandingProb - EPS);
  const chosen = meeting.length
    ? meeting.reduce((best, a) => (a.tipLamports < best.tipLamports ? a : best))
    : alts.reduce((best, a) =>
        a.projectedLandingProb > best.projectedLandingProb ||
        (a.projectedLandingProb === best.projectedLandingProb && a.tipLamports < best.tipLamports)
          ? a
          : best,
      );

  for (const a of alts) {
    if (a === chosen) continue;
    a.rejectedReason =
      a.tipLamports < chosen.tipLamports
        ? `landing prob ${pct(a.projectedLandingProb)} < target ${pct(constraints.targetLandingProb)}`
        : `costs ${a.tipLamports} lamports for only +${pct(a.projectedLandingProb - chosen.projectedLandingProb)} landing prob`;
  }

  // Hold only when even the strongest affordable option can't meet the target and tips are
  // rising under congestion — i.e. submitting now would likely just burn a tip.
  const action: 'submit' | 'hold' =
    !meeting.length && health.regime === 'congested' && health.tipFloorSlope > 0
      ? 'hold'
      : 'submit';

  const rationale =
    action === 'hold'
      ? `Target ${pct(constraints.targetLandingProb)} unreachable under ceiling while congestion is rising; holding to avoid burning a tip.`
      : `Regime=${health.regime}. Chose ${chosen.option} (${chosen.tipLamports} lamports) as ${meeting.length ? 'cheapest tip meeting' : 'best available toward'} ~${pct(chosen.projectedLandingProb)} landing prob` +
        (failedFeeLow ? ' after a prior fee_too_low failure.' : '.');

  return {
    action,
    tipLamports: chosen.tipLamports,
    rationale,
    consideredAlternatives: alts,
    confidence: meeting.length ? 0.75 : 0.5,
  };
}

/** Base landing probability per tip-floor percentile band, in normal conditions. */
const PERCENTILE_BASE: Record<string, number> = { p25: 0.55, p50: 0.7, p75: 0.85, p95: 0.95 };

/** Landing-prob estimate: prefer the system's MEASURED rate for the tip's bucket once we have
 *  enough samples; otherwise a percentile-keyed prior adjusted for the regime. This is where
 *  the learning shows up — more runs replace the prior with observed behavior. */
function landingProb(option: string, tip: number, ctx: AgentContext): number {
  const measured = ctx.telemetry.find((t) => t.bucket === bucketFor(tip));
  if (measured && measured.attempts >= 3) return measured.landingRate;

  const base = PERCENTILE_BASE[option] ?? 0.6;
  const adj = ctx.health.regime === 'congested' ? -0.15 : ctx.health.regime === 'calm' ? 0.05 : 0;
  return clamp01(base + adj);
}

function pct(n: number): string {
  return `${Math.round(clamp01(n) * 100)}%`;
}
