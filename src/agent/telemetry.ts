import { readFileSync, existsSync } from 'node:fs';
import { LandingStat } from './types.js';

/**
 * Read past lifecycle logs and compute observed landing rate per tip bucket. This is the
 * system's OWN measured behavior — the agent reasons over this rather than generic
 * heuristics, which is the differentiator: tips are learned, not hardcoded.
 */
export function loadTelemetry(path = 'logs/lifecycle.jsonl'): LandingStat[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const buckets = new Map<string, { attempts: number; landed: number }>();

  for (const line of lines) {
    try {
      const rec = JSON.parse(line) as {
        tipLamports: number;
        landedSlot: number | null;
        failure: string | null;
      };
      const bucket = bucketFor(rec.tipLamports);
      const b = buckets.get(bucket) ?? { attempts: 0, landed: 0 };
      b.attempts += 1;
      if (rec.landedSlot != null && !rec.failure) b.landed += 1;
      buckets.set(bucket, b);
    } catch {
      /* skip malformed line */
    }
  }

  return [...buckets.entries()].map(([bucket, b]) => ({
    bucket,
    attempts: b.attempts,
    landed: b.landed,
    landingRate: b.attempts ? b.landed / b.attempts : 0,
  }));
}

export function bucketFor(lamports: number): string {
  if (lamports < 2_000) return '<2k';
  if (lamports < 10_000) return '2k-10k';
  if (lamports < 50_000) return '10k-50k';
  if (lamports < 200_000) return '50k-200k';
  return '200k+';
}
