import { JITO_BUNDLE_API, FALLBACK_TIP_ACCOUNTS } from '../config.js';

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

/**
 * Ask the block engine for the canonical set of tip accounts at runtime.
 * Preferred over any hardcoded list — falls back only if the call fails.
 */
export async function getTipAccounts(): Promise<string[]> {
  try {
    const res = await fetch(JITO_BUNDLE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTipAccounts',
        params: [],
      }),
    });
    const json = (await res.json()) as JsonRpcResponse<string[]>;
    if (json.error) throw new Error(json.error.message);
    if (json.result && json.result.length > 0) return json.result;
    throw new Error('getTipAccounts returned empty');
  } catch (err) {
    console.warn(
      `[tipAccounts] runtime fetch failed (${(err as Error).message}); using fallback list`,
    );
    return FALLBACK_TIP_ACCOUNTS;
  }
}

/** Pick a tip account at random — spreads load across the 8 accounts as Jito intends. */
export function pickTipAccount(accounts: string[]): string {
  return accounts[Math.floor(Math.random() * accounts.length)];
}
