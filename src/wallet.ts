import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { SIGNER_SECRET_KEY } from './config.js';

export function loadSigner(): Keypair {
  if (!SIGNER_SECRET_KEY) {
    throw new Error(
      'SIGNER_SECRET_KEY is empty. Run `npm run genkey`, set it in .env, and fund the wallet.',
    );
  }
  return Keypair.fromSecretKey(bs58.decode(SIGNER_SECRET_KEY));
}
