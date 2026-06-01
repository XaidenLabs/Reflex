import Client, {
  CommitmentLevel,
  SubscribeRequest,
  SubscribeUpdate,
} from '@triton-one/yellowstone-grpc';
import bs58 from 'bs58';

/** Resolved gRPC duplex stream type without importing @grpc/grpc-js directly. */
type GeyserStream = Awaited<ReturnType<Client['subscribe']>>;

export type SlotStatus =
  | 'processed'
  | 'confirmed'
  | 'finalized'
  | 'first_shred'
  | 'completed'
  | 'created_bank'
  | 'dead'
  | 'unknown';

function mapStatus(status: number): SlotStatus {
  switch (status) {
    case CommitmentLevel.PROCESSED:
      return 'processed';
    case CommitmentLevel.CONFIRMED:
      return 'confirmed';
    case CommitmentLevel.FINALIZED:
      return 'finalized';
    case CommitmentLevel.FIRST_SHRED_RECEIVED:
      return 'first_shred';
    case CommitmentLevel.COMPLETED:
      return 'completed';
    case CommitmentLevel.CREATED_BANK:
      return 'created_bank';
    case CommitmentLevel.DEAD:
      return 'dead';
    default:
      return 'unknown';
  }
}

type SlotListener = (slot: number, status: SlotStatus, parent: number | null, tsMs: number) => void;
type TxListener = (signature: string, slot: number, failed: boolean, tsMs: number) => void;
type ReconnectListener = (attempt: number) => void;

export interface YellowstoneOptions {
  endpoint: string;
  token?: string;
  /** accounts whose transactions we want to observe (e.g. our signer) */
  watchAccounts?: string[];
  /** backpressure: pause the stream above this many queued updates */
  highWatermark?: number;
  /** backpressure: resume the stream once queued updates fall below this */
  lowWatermark?: number;
  /** hard cap; beyond this we drop oldest as a last resort and count it */
  maxQueue?: number;
}

const EMPTY_REQUEST: SubscribeRequest = {
  accounts: {},
  slots: {},
  transactions: {},
  transactionsStatus: {},
  blocks: {},
  blocksMeta: {},
  entry: {},
  accountsDataSlice: [],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A resilient Yellowstone gRPC subscriber.
 * - Reconnects with exponential backoff (resetting on healthy data).
 * - Real backpressure via pause()/resume() watermarks, plus a hard-cap drop counter.
 * - Replies to server pings to keep the connection alive.
 * Subscribe to slot status transitions and (optionally) one account's transactions.
 */
export class YellowstoneStream {
  private stopped = false;
  private stream: GeyserStream | null = null;
  private queue: SubscribeUpdate[] = [];
  private draining = false;
  private paused = false;
  private backoffMs = 500;

  private reconnects = 0;
  private dropped = 0;

  private slotListeners: SlotListener[] = [];
  private txListeners: TxListener[] = [];
  private reconnectListeners: ReconnectListener[] = [];

  constructor(private readonly opts: YellowstoneOptions) {}

  onSlot(cb: SlotListener): void {
    this.slotListeners.push(cb);
  }
  onTransaction(cb: TxListener): void {
    this.txListeners.push(cb);
  }
  onReconnect(cb: ReconnectListener): void {
    this.reconnectListeners.push(cb);
  }

  get metrics() {
    return { reconnects: this.reconnects, dropped: this.dropped, queued: this.queue.length };
  }

  async start(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        // connectOnce resolves when the stream ends; loop to reconnect unless stopped.
      } catch (err) {
        if (this.stopped) break;
        this.reconnects += 1;
        this.reconnectListeners.forEach((cb) => cb(this.reconnects));
        console.warn(
          `[yellowstone] disconnected (${(err as Error).message}); reconnecting in ${this.backoffMs}ms (attempt ${this.reconnects})`,
        );
        await sleep(this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    try {
      this.stream?.cancel();
    } catch {
      /* ignore */
    }
  }

  private buildRequest(): SubscribeRequest {
    const transactions: SubscribeRequest['transactions'] = {};
    if (this.opts.watchAccounts?.length) {
      transactions['watched'] = {
        vote: false,
        failed: true, // include failed txs so we can classify them
        accountInclude: this.opts.watchAccounts,
        accountExclude: [],
        accountRequired: [],
      };
    }
    return {
      ...EMPTY_REQUEST,
      // filterByCommitment:false → receive every status transition for each slot.
      slots: { all: { filterByCommitment: false } },
      transactions,
      commitment: CommitmentLevel.PROCESSED,
    };
  }

  private async connectOnce(): Promise<void> {
    const ClientClass = (Client as any).default || Client;
    const client = new ClientClass(this.opts.endpoint, this.opts.token, {
      'grpc.max_receive_message_length': 64 * 1024 * 1024,
    });
    const stream = await client.subscribe();
    this.stream = stream;

    const ended = new Promise<void>((resolve, reject) => {
      stream.on('data', (u: SubscribeUpdate) => {
        this.backoffMs = 500; // healthy data → reset backoff
        if (u.ping) {
          this.safeWrite({ ...EMPTY_REQUEST, ping: { id: 1 } });
          return;
        }
        this.enqueue(u);
      });
      stream.on('error', (e: Error) => reject(e));
      stream.on('end', () => resolve());
      stream.on('close', () => resolve());
    });

    await new Promise<void>((res, rej) =>
      stream.write(this.buildRequest(), (e: Error | null | undefined) => (e ? rej(e) : res())),
    );

    await ended;
  }

  private safeWrite(req: SubscribeRequest): void {
    try {
      this.stream?.write(req, () => {});
    } catch {
      /* ignore */
    }
  }

  private enqueue(u: SubscribeUpdate): void {
    const max = this.opts.maxQueue ?? 5000;
    if (this.queue.length >= max) {
      this.queue.shift();
      this.dropped += 1;
    }
    this.queue.push(u);

    const high = this.opts.highWatermark ?? 2000;
    if (!this.paused && this.queue.length > high) {
      this.paused = true;
      this.stream?.pause();
    }
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    const low = this.opts.lowWatermark ?? 500;
    let processed = 0;
    while (this.queue.length) {
      const u = this.queue.shift()!;
      this.handle(u);
      if (this.paused && this.queue.length < low) {
        this.paused = false;
        this.stream?.resume();
      }
      if (++processed % 256 === 0) await Promise.resolve(); // yield to the event loop
    }
    this.draining = false;
  }

  private handle(u: SubscribeUpdate): void {
    const ts = Date.now();
    if (u.slot) {
      const slot = Number(u.slot.slot);
      const parent = u.slot.parent != null ? Number(u.slot.parent) : null;
      const status = mapStatus(u.slot.status);
      this.slotListeners.forEach((cb) => cb(slot, status, parent, ts));
    } else if (u.transaction?.transaction) {
      const sig = bs58.encode(u.transaction.transaction.signature);
      const slot = Number(u.transaction.slot);
      const failed = u.transaction.transaction.meta?.err != null;
      this.txListeners.forEach((cb) => cb(sig, slot, failed, ts));
    }
  }
}
