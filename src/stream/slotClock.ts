import { SlotStatus } from './yellowstone.js';

export interface SlotStages {
  processedAt?: number;
  confirmedAt?: number;
  finalizedAt?: number;
  firstShredAt?: number;
}

export type Stage = 'processed' | 'confirmed' | 'finalized';

interface Waiter {
  slot: number;
  stage: Stage;
  resolve: () => void;
}

function stageRank(s: Stage): number {
  return s === 'processed' ? 0 : s === 'confirmed' ? 1 : 2;
}

function reached(s: SlotStages, stage: Stage): boolean {
  if (stage === 'processed') return s.processedAt != null || s.confirmedAt != null || s.finalizedAt != null;
  if (stage === 'confirmed') return s.confirmedAt != null || s.finalizedAt != null;
  return s.finalizedAt != null;
}

/**
 * Maintains the commitment timeline for recent slots from the stream. This is what lets us
 * confirm landing (and measure latency deltas) from stream data instead of RPC polling, and
 * it feeds the network-health signal (median processed->confirmed delta, etc).
 */
export class SlotClock {
  private slots = new Map<number, SlotStages>();
  private waiters: Waiter[] = [];
  headSlot = 0;

  constructor(private readonly keepSlots = 400) {}

  record(slot: number, status: SlotStatus, tsMs: number): void {
    if (slot > this.headSlot) this.headSlot = slot;
    const s = this.slots.get(slot) ?? {};
    if (status === 'processed' && s.processedAt == null) s.processedAt = tsMs;
    else if (status === 'confirmed' && s.confirmedAt == null) s.confirmedAt = tsMs;
    else if (status === 'finalized' && s.finalizedAt == null) s.finalizedAt = tsMs;
    else if (status === 'first_shred' && s.firstShredAt == null) s.firstShredAt = tsMs;
    this.slots.set(slot, s);

    if (status === 'processed' || status === 'confirmed' || status === 'finalized') {
      this.resolveWaiters(slot, status);
    }
    this.prune();
  }

  stages(slot: number): SlotStages | undefined {
    return this.slots.get(slot);
  }

  /** Recent processed->confirmed deltas (ms) — the README Q1 health signal. */
  recentProcessedToConfirmedDeltas(window = 150): number[] {
    const out: number[] = [];
    for (const [slot, s] of this.slots) {
      if (slot <= this.headSlot - window) continue;
      if (s.processedAt != null && s.confirmedAt != null) out.push(s.confirmedAt - s.processedAt);
    }
    return out;
  }

  /** Resolve when `slot` reaches `stage` (or immediately if it already has). */
  waitFor(slot: number, stage: Stage, timeoutMs?: number): Promise<void> {
    const s = this.slots.get(slot);
    if (s && reached(s, stage)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = { slot, stage, resolve };
      this.waiters.push(w);
      if (timeoutMs != null) {
        setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== w);
          reject(new Error(`timeout waiting for slot ${slot} to reach ${stage}`));
        }, timeoutMs);
      }
    });
  }

  private resolveWaiters(slot: number, stage: Stage): void {
    const ready: Waiter[] = [];
    this.waiters = this.waiters.filter((w) => {
      if (w.slot === slot && stageRank(stage) >= stageRank(w.stage)) {
        ready.push(w);
        return false;
      }
      return true;
    });
    ready.forEach((w) => w.resolve());
  }

  private prune(): void {
    if (this.slots.size <= this.keepSlots) return;
    const threshold = this.headSlot - this.keepSlots;
    for (const k of this.slots.keys()) if (k < threshold) this.slots.delete(k);
  }
}
