/** The owned decision: Autonomous Retry with Fault Injection.
 *  On every (re)attempt the agent reasons over conditions + prior failures and decides
 *  the tip and whether to submit or hold. This subsumes tip intelligence and failure
 *  reasoning into one decision surface. */

export interface TipFloorView {
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  ema50: number;
}

export interface NetworkHealth {
  /** fraction of recent slots that were skipped (0..1) */
  slotSkipRate: number;
  /** median processed->confirmed delta over the recent window (README Q1 signal) */
  medianProcessedToConfirmedMs: number | null;
  /** recent change in the p50 tip floor (lamports), positive = tips rising */
  tipFloorSlope: number;
  regime: 'calm' | 'normal' | 'congested';
}

export interface AttemptRecord {
  attempt: number;
  tipLamports: number;
  failure: string | null;
  landedSlot: number | null;
}

/** Learned from past runs (logs/lifecycle.jsonl) — the system's own measured behavior. */
export interface LandingStat {
  bucket: string;
  attempts: number;
  landed: number;
  landingRate: number;
}

export interface AgentConstraints {
  minTipLamports: number;
  maxTipLamports: number; // hard cost ceiling
  maxAttempts: number;
  targetLandingProb: number; // 0..1
}

export interface AgentContext {
  tipFloor: TipFloorView;
  health: NetworkHealth;
  history: AttemptRecord[];
  telemetry: LandingStat[];
  constraints: AgentConstraints;
}

export interface ConsideredAlternative {
  option: string;
  tipLamports: number;
  projectedLandingProb: number;
  projectedCostLamports: number;
  rejectedReason: string;
}

export interface AgentDecision {
  action: 'submit' | 'hold';
  tipLamports: number;
  rationale: string;
  consideredAlternatives: ConsideredAlternative[];
  confidence: number; // 0..1
  source: 'llm' | 'heuristic-fallback';
}
