/**
 * Submit one real Jito bundle and track its lifecycle. Run: `npm run bundle`
 *
 * Needs only a funded mainnet wallet (SIGNER_SECRET_KEY) — NO gRPC endpoint. This is
 * your first explorer-verifiable submission. Confirmation here is via getBundleStatuses
 * polling; the stream layer (next milestone) upgrades this to stream-based confirmation,
 * which is what the bounty requires for the final logs.
 */
import { Connection } from '@solana/web3.js';
import { mkdirSync, appendFileSync } from 'node:fs';
import { RPC_URL } from './config.js';
import { loadSigner } from './wallet.js';
import { getTipAccounts, pickTipAccount } from './jito/tipAccounts.js';
import { decideTip } from './tipPolicy.js';
import {
  buildSelfTransferBundleTx,
  sendBundle,
  getBundleStatuses,
  getInflightBundleStatuses,
} from './jito/bundle.js';
import { classifyFailure } from './jito/failures.js';
import { newRecord, mark, Stage } from './lifecycle.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');
  const signer = loadSigner();
  console.log('Signer:', signer.publicKey.toBase58());

  const accounts = await getTipAccounts();
  const tipAccount = pickTipAccount(accounts);
  const tip = await decideTip();
  console.log(`Tip: ${tip.lamports} lamports -> ${tipAccount}`);
  console.log(`     (${tip.rationale})`);

  const built = await buildSelfTransferBundleTx({
    conn,
    signer,
    tipAccount,
    tipLamports: tip.lamports,
  });
  const rec = newRecord(built.signature, tip.lamports, tip.rationale);
  console.log('Signature:', built.signature);

  const bundleId = await sendBundle([built.tx]);
  rec.bundleId = bundleId;
  console.log('Bundle ID:', bundleId);

  let landed = false;
  const startHeight = await conn.getBlockHeight('confirmed');
  console.log(`Watching... (blockhash valid through height ${built.lastValidBlockHeight}, now ${startHeight})`);

  while (true) {
    const status = await getBundleStatuses(bundleId);
    if (status && status.confirmation_status) {
      rec.landedSlot = status.slot;
      const cs = status.confirmation_status;
      if (cs === 'processed' || cs === 'confirmed' || cs === 'finalized') {
        mark(rec, cs as Stage);
      }
      if (status.err) {
        rec.failure = classifyFailure({ err: status.err });
        break;
      }
      if (cs === 'confirmed' || cs === 'finalized') {
        landed = true;
        break;
      }
    }

    const height = await conn.getBlockHeight('confirmed');
    if (height > built.lastValidBlockHeight) {
      const inflight = await getInflightBundleStatuses(bundleId);
      rec.failure = classifyFailure({
        blockhashExpired: true,
        inflightStatus: inflight?.status ?? null,
      });
      break;
    }
    await sleep(1000);
  }

  if (landed) {
    console.log(`\n✅ LANDED in slot ${rec.landedSlot}`);
    console.log(`   Verify: https://solscan.io/tx/${rec.signature}`);
  } else {
    console.log(`\n❌ NOT LANDED — classified as: ${rec.failure}`);
  }
  console.log('Latency deltas (ms):', rec.deltasMs);

  mkdirSync('logs', { recursive: true });
  appendFileSync('logs/lifecycle.jsonl', JSON.stringify(rec) + '\n');
  console.log('Appended to logs/lifecycle.jsonl');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
