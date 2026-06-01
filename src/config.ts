import 'dotenv/config';

/** Jito block engine (mainnet only — Jito bundles do not work on devnet). */
export const JITO_BLOCK_ENGINE =
  process.env.JITO_BLOCK_ENGINE ?? 'https://mainnet.block-engine.jito.wtf';

/** Bundle JSON-RPC path: sendBundle, getBundleStatuses, getInflightBundleStatuses, getTipAccounts, getNextScheduledLeader. */
export const JITO_BUNDLE_API = `${JITO_BLOCK_ENGINE}/api/v1/bundles`;

/** Public tip-floor endpoint — live percentiles of recently landed tips. */
export const JITO_TIP_FLOOR_URL =
  process.env.JITO_TIP_FLOOR_URL ??
  'https://bundles.jito.wtf/api/v1/bundles/tip_floor';

/** Jito enforces a minimum tip of 1000 lamports for bundles. */
export const JITO_MIN_TIP_LAMPORTS = 1000;

export const LAMPORTS_PER_SOL = 1_000_000_000;

export const RPC_URL = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com';
export const GRPC_URL = process.env.GRPC_URL ?? '';
export const GRPC_TOKEN = process.env.GRPC_TOKEN ?? '';
export const SIGNER_SECRET_KEY = process.env.SIGNER_SECRET_KEY ?? '';

/**
 * Fallback tip accounts. At runtime we ALWAYS call getTipAccounts() and use that
 * result — this list is only a safety net if the call fails. Never hardcode tip
 * AMOUNTS; those come from the live tip floor (see jito/tipFloor.ts).
 */
export const FALLBACK_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSLLWDMFf4t6U82o6QY',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];
