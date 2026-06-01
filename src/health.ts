import { SlotClock } from './stream/slotClock.js';
import { NetworkHealth } from './agent/types.js';

/**
 * Derives a live network-health regime from streamed data. This operationalizes README Q1:
 * the processed->confirmed delta becomes a real control input, alongside slot-skip rate and
 * the trajectory of the tip floor. Feed tip-floor samples as you fetch them.
 */
export class HealthMonitor {
  private p50Samples: Array<{ ts: number; p50: number }> = [];

  constructor(
    private readonly clock: SlotClock,
    private readonly keepSamples = 20,
  ) {}

  recordTipFloorSample(p50: number, ts: number = Date.now()): void {
    this.p50Samples.push({ ts, p50 });
    if (this.p50Samples.length > this.keepSamples) this.p50Samples.shift();
  }

  /** lamports/minute change in the p50 tip floor (positive = tips rising) */
  private tipFloorSlope(): number {
    if (this.p50Samples.length < 2) return 0;
    const first = this.p50Samples[0];
    const last = this.p50Samples[this.p50Samples.length - 1];
    const minutes = Math.max((last.ts - first.ts) / 60_000, 1 / 60);
    return (last.p50 - first.p50) / minutes;
  }

  /** fraction of recent slots that never reached processed (approx skip rate) */
  private slotSkipRate(window = 120): number {
    const head = this.clock.headSlot;
    if (head === 0) return 0;
    const start = head - window - 10; // trail the head so recent slots have had time to appear
    const end = head - 10;
    if (end <= start) return 0;
    let seen = 0;
    for (let s = start; s <= end; s++) {
      if (this.clock.stages(s)?.processedAt != null) seen += 1;
    }
    const expected = end - start + 1;
    return Math.max(0, Math.min(1, 1 - seen / expected));
  }

  snapshot(): NetworkHealth {
    const deltas = this.clock.recentProcessedToConfirmedDeltas();
    const sorted = [...deltas].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    const skip = this.slotSkipRate();
    const slope = this.tipFloorSlope();

    const congested = skip > 0.08 || (median != null && median > 1500) || slope > 2000;
    const calm = skip < 0.02 && (median == null || median < 600) && slope <= 0;
    const regime: NetworkHealth['regime'] = congested ? 'congested' : calm ? 'calm' : 'normal';

    return {
      slotSkipRate: skip,
      medianProcessedToConfirmedMs: median,
      tipFloorSlope: slope,
      regime,
    };
  }
}

export function neutralHealth(): NetworkHealth {
  return {
    slotSkipRate: 0,
    medianProcessedToConfirmedMs: null,
    tipFloorSlope: 0,
    regime: 'normal',
  };
}
