/**
 * Generate a throwaway mainnet keypair. Run: `npm run genkey`
 * Put the printed secret into SIGNER_SECRET_KEY in .env, then fund the public key
 * with ~0.05-0.1 SOL. Never reuse a wallet that holds real value.
 */
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const kp = Keypair.generate();
console.log('Public key  :', kp.publicKey.toBase58());
console.log('Secret (b58):', bs58.encode(kp.secretKey));
console.log('\n→ Put the secret in SIGNER_SECRET_KEY in .env');
console.log('→ Fund the public key with ~0.05-0.1 SOL on MAINNET');
