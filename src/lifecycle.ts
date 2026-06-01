/** Commitment stages we track for every submission. */
export type Stage = 'submitted' | 'processed' | 'confirmed' | 'finalized';

const STAGE_ORDER: Stage[] = ['submitted', 'processed', 'confirmed', 'finalized'];

export interface LifecycleRecord {
  bundleId: string | null;
  signature: string;
  tipLamports: number;
  tipRationale: string;
  landedSlot: number | null;
  /** stage -> epoch milliseconds when first observed */
  stages: Partial<Record<Stage, number>>;
  /** e.g. "processed->confirmed": 412 (ms) */
  deltasMs: Record<string, number>;
  failure: string | null;
  createdAt: string;
}

export function newRecord(
  signature: string,
  tipLamports: number,
  tipRationale: string,
): LifecycleRecord {
  return {
    bundleId: null,
    signature,
    tipLamports,
    tipRationale,
    landedSlot: null,
    stages: { submitted: Date.now() },
    deltasMs: {},
    failure: null,
    createdAt: new Date().toISOString(),
  };
}

/** Record the first time we observe a stage; recompute consecutive deltas.
 *  Pass `atMs` to use a stream-observed timestamp instead of now. */
export function mark(rec: LifecycleRecord, stage: Stage, atMs: number = Date.now()): void {
  if (rec.stages[stage] != null) return;
  rec.stages[stage] = atMs;
  for (let i = 1; i < STAGE_ORDER.length; i++) {
    const a = rec.stages[STAGE_ORDER[i - 1]];
    const b = rec.stages[STAGE_ORDER[i]];
    if (a != null && b != null) {
      rec.deltasMs[`${STAGE_ORDER[i - 1]}->${STAGE_ORDER[i]}`] = b - a;
    }
  }
}
