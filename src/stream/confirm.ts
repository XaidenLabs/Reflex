import { YellowstoneStream } from './yellowstone.js';
import { SlotClock } from './slotClock.js';

export interface StreamConfirmation {
  signature: string;
  landedSlot: number;
  failed: boolean;
  /** ms timestamps observed from the stream */
  processedAt: number;
  confirmedAt: number | null;
  finalizedAt: number | null;
}

interface Pending {
  resolve: (c: StreamConfirmation) => void;
  reject: (e: Error) => void;
  waitFinalized: boolean;
}

/**
 * Confirms landing from STREAM data (not RPC polling), as the bounty requires.
 * Wire it to a YellowstoneStream that watches the signer's account. Call watch(signature)
 * BEFORE submitting; it resolves once the tx is seen processed and its slot reaches the
 * requested commitment.
 */
export class LifecycleConfirmer {
  private pending = new Map<string, Pending>();

  constructor(
    private readonly stream: YellowstoneStream,
    private readonly clock: SlotClock,
  ) {
    this.stream.onSlot((slot, status, _parent, ts) => this.clock.record(slot, status, ts));
    this.stream.onTransaction((sig, slot, failed, ts) => {
      void this.onTransaction(sig, slot, failed, ts);
    });
  }

  /** Begin watching for a signature. `untilFinalized=false` resolves at confirmed. */
  watch(signature: string, untilFinalized = false): Promise<StreamConfirmation> {
    return new Promise<StreamConfirmation>((resolve, reject) => {
      this.pending.set(signature, { resolve, reject, waitFinalized: untilFinalized });
    });
  }

  /** Stop watching (e.g. on blockhash expiry) and reject the waiter. */
  abandon(signature: string, reason: string): void {
    const p = this.pending.get(signature);
    if (p) {
      this.pending.delete(signature);
      p.reject(new Error(reason));
    }
  }

  private async onTransaction(sig: string, slot: number, failed: boolean, processedAt: number): Promise<void> {
    const p = this.pending.get(sig);
    if (!p) return;
    this.pending.delete(sig);

    try {
      await this.clock.waitFor(slot, 'confirmed', 60_000);
      const confirmedAt = this.clock.stages(slot)?.confirmedAt ?? Date.now();

      let finalizedAt: number | null = null;
      if (p.waitFinalized) {
        await this.clock.waitFor(slot, 'finalized', 90_000);
        finalizedAt = this.clock.stages(slot)?.finalizedAt ?? null;
      }

      p.resolve({ signature: sig, landedSlot: slot, failed, processedAt, confirmedAt, finalizedAt });
    } catch (err) {
      p.reject(err as Error);
    }
  }
}
