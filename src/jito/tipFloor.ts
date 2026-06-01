import { JITO_TIP_FLOOR_URL, LAMPORTS_PER_SOL } from '../config.js';

/** Raw shape returned by the tip_floor endpoint (values are in SOL). */
interface TipFloorRaw {
  time: string;
  landed_tips_25th_percentile: number;
  landed_tips_50th_percentile: number;
  landed_tips_75th_percentile: number;
  landed_tips_95th_percentile: number;
  landed_tips_99th_percentile: number;
  ema_landed_tips_50th_percentile: number;
}

/** Percentiles normalized to lamports (integers), which is what we tip in. */
export interface TipFloorLamports {
  time: string;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  ema50: number;
}

const solToLamports = (sol: number) => Math.round(sol * LAMPORTS_PER_SOL);

/**
 * Fetch the current Jito tip floor. This is the live, real data that the tip
 * intelligence layer reasons over — no hardcoded tip amounts anywhere.
 */
export async function getTipFloor(): Promise<TipFloorLamports> {
  const res = await fetch(JITO_TIP_FLOOR_URL);
  if (!res.ok) {
    throw new Error(`tip_floor HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as TipFloorRaw[];
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('tip_floor returned no data');
  }
  const f = data[0];
  return {
    time: f.time,
    p25: solToLamports(f.landed_tips_25th_percentile),
    p50: solToLamports(f.landed_tips_50th_percentile),
    p75: solToLamports(f.landed_tips_75th_percentile),
    p95: solToLamports(f.landed_tips_95th_percentile),
    p99: solToLamports(f.landed_tips_99th_percentile),
    ema50: solToLamports(f.ema_landed_tips_50th_percentile),
  };
}
