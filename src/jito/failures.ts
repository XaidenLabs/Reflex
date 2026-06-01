export type FailureClass =
  | 'expired_blockhash'
  | 'fee_too_low'
  | 'compute_exceeded'
  | 'bundle_failure'
  | 'not_landed'
  | 'unknown';

/**
 * Classify why a submission did not land. Inputs come from observed state, not guesses:
 * blockhash height check, Jito inflight status, and the on-chain err (if any).
 * The AI agent later reasons over this classification to decide what to change.
 */
export function classifyFailure(input: {
  blockhashExpired?: boolean;
  inflightStatus?: string | null; // Invalid | Pending | Failed | Landed
  err?: unknown;
}): FailureClass {
  if (input.blockhashExpired) return 'expired_blockhash';

  const errStr = input.err ? JSON.stringify(input.err).toLowerCase() : '';
  if (errStr.includes('blockhash')) return 'expired_blockhash';
  if (errStr.includes('compute') || errStr.includes('computational budget')) {
    return 'compute_exceeded';
  }

  // Dropped in the auction (not selected) most commonly means the tip was not
  // competitive for current conditions.
  if (input.inflightStatus === 'Failed' || input.inflightStatus === 'Invalid') {
    return 'fee_too_low';
  }

  if (errStr) return 'bundle_failure';
  return 'not_landed';
}
