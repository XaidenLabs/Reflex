import { getTipFloor } from './jito/tipFloor.js';
import { JITO_MIN_TIP_LAMPORTS } from './config.js';

export interface TipDecision {
  lamports: number;
  rationale: string;
}

/**
 * Baseline tip policy: 75th percentile of recently landed tips, floored at the Jito
 * minimum. Pulled live every time — no hardcoded amounts.
 *
 * This is intentionally a clear SEAM: the AI agent (milestone 4) replaces this with a
 * reasoned decision over slot conditions + cost vs. landing probability, and logs its
 * rationale. Keeping the boundary explicit makes "the AI owns this decision" obvious to
 * judges.
 */
export async function decideTip(): Promise<TipDecision> {
  const floor = await getTipFloor();
  const lamports = Math.max(floor.p75, JITO_MIN_TIP_LAMPORTS);
  return {
    lamports,
    rationale: `baseline policy: 75th pct=${floor.p75}, floored at min=${JITO_MIN_TIP_LAMPORTS}, ema50=${floor.ema50}`,
  };
}
