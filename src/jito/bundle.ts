import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { JITO_BUNDLE_API } from '../config.js';

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

async function jitoRpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(JITO_BUNDLE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as JsonRpcResponse<T>;
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}

export interface BuiltBundleTx {
  tx: VersionedTransaction;
  signature: string;
  blockhash: string;
  lastValidBlockHeight: number;
}

/**
 * Build a single-transaction bundle: a tiny 1-lamport self transfer (a real payload)
 * plus the Jito tip transfer as the FINAL instruction. The tip is required for the
 * bundle to be considered. Blockhash is fetched at 'confirmed' commitment — recent
 * enough to keep almost the full validity window, but voted-on to avoid fork drop
 * (see README Q2).
 */
export async function buildSelfTransferBundleTx(opts: {
  conn: Connection;
  signer: Keypair;
  tipAccount: string;
  tipLamports: number;
  blockhash?: string;
  lastValidBlockHeight?: number;
}): Promise<BuiltBundleTx> {
  const { conn, signer, tipAccount, tipLamports } = opts;

  let { blockhash, lastValidBlockHeight } = opts;
  if (!blockhash || lastValidBlockHeight == null) {
    ({ blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed'));
  }

  const instructions = [
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: signer.publicKey,
      lamports: 1,
    }),
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: new PublicKey(tipAccount),
      lamports: tipLamports,
    }),
  ];

  const message = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([signer]);
  const signature = bs58.encode(tx.signatures[0]);

  return { tx, signature, blockhash, lastValidBlockHeight };
}

/** Submit signed transactions as an atomic bundle. Returns the bundle id. */
export async function sendBundle(txs: VersionedTransaction[]): Promise<string> {
  const encoded = txs.map((t) => bs58.encode(t.serialize()));
  return jitoRpc<string>('sendBundle', [encoded]);
}

export interface BundleStatusValue {
  bundle_id: string;
  transactions: string[];
  slot: number;
  confirmation_status: string | null; // processed | confirmed | finalized
  err: unknown;
}

/** Detailed status (slot + commitment) once a bundle has been seen on-chain. */
export async function getBundleStatuses(bundleId: string): Promise<BundleStatusValue | null> {
  const result = await jitoRpc<{ value: BundleStatusValue[] }>('getBundleStatuses', [[bundleId]]);
  return result?.value?.[0] ?? null;
}

export interface InflightStatus {
  bundle_id: string;
  status: string; // Invalid | Pending | Failed | Landed
  landed_slot: number | null;
}

/** Lightweight liveness status — useful to tell "still pending" from "dropped". */
export async function getInflightBundleStatuses(bundleId: string): Promise<InflightStatus | null> {
  const result = await jitoRpc<{ value: InflightStatus[] }>(
    'getInflightBundleStatuses',
    [[bundleId]],
  );
  return result?.value?.[0] ?? null;
}
