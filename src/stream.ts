/**
 * Stream verifier. Run: `npm run stream`
 *
 * Requires a Yellowstone gRPC endpoint (GRPC_URL + GRPC_TOKEN in .env). Connects, tracks
 * every slot through processed -> confirmed -> finalized, and prints a live status line plus
 * the median processed->confirmed delta (your README Q1 signal) and connection metrics.
 *
 * If SIGNER_SECRET_KEY is set, it also watches that account's transactions and prints them.
 */
import { GRPC_URL, GRPC_TOKEN, SIGNER_SECRET_KEY } from './config.js';
import { YellowstoneStream } from './stream/yellowstone.js';
import { SlotClock } from './stream/slotClock.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  if (!GRPC_URL) {
    console.error('GRPC_URL is empty. Set GRPC_URL + GRPC_TOKEN in .env once you have an endpoint.');
    process.exit(1);
  }

  const clock = new SlotClock();
  let watchAccounts: string[] | undefined;
  if (SIGNER_SECRET_KEY) {
    const signer = Keypair.fromSecretKey(bs58.decode(SIGNER_SECRET_KEY));
    watchAccounts = [signer.publicKey.toBase58()];
    console.log('Watching signer account:', watchAccounts[0]);
  }

  const stream = new YellowstoneStream({
    endpoint: GRPC_URL,
    token: GRPC_TOKEN || undefined,
    watchAccounts,
  });

  stream.onSlot((slot, status, _parent, ts) => clock.record(slot, status, ts));
  stream.onTransaction((sig, slot, failed) => {
    console.log(`  [tx] ${sig} landed in slot ${slot}${failed ? ' (FAILED)' : ''}`);
  });
  stream.onReconnect((n) => console.log(`  [reconnect] attempt ${n}`));

  // Periodic status line so you can see it working and verify health metrics.
  setInterval(() => {
    const deltas = clock.recentProcessedToConfirmedDeltas();
    const med = median(deltas);
    const m = stream.metrics;
    console.log(
      `head=${clock.headSlot}  proc→conf median=${med == null ? 'n/a' : med + 'ms'}  ` +
        `(n=${deltas.length})  reconnects=${m.reconnects} dropped=${m.dropped} queued=${m.queued}`,
    );
  }, 2000);

  console.log('Connecting to Yellowstone...');
  await stream.start();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
