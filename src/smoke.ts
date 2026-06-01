/**
 * Zero-infrastructure smoke test.
 *
 * Hits only free, public Jito endpoints — no gRPC endpoint, no wallet, no funds.
 * Confirms your toolchain works and that you can pull the LIVE data the tip
 * intelligence layer will reason over. Run with: `npm run smoke`.
 */
import { getTipFloor } from './jito/tipFloor.js';
import { getTipAccounts } from './jito/tipAccounts.js';
import { LAMPORTS_PER_SOL, JITO_MIN_TIP_LAMPORTS } from './config.js';

const sol = (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(9);

async function main() {
  console.log('=== Live Jito tip floor ===');
  const floor = await getTipFloor();
  console.log(`as of: ${floor.time}`);
  const rows: [string, number][] = [
    ['25th pct', floor.p25],
    ['50th pct', floor.p50],
    ['75th pct', floor.p75],
    ['95th pct', floor.p95],
    ['99th pct', floor.p99],
    ['EMA 50th', floor.ema50],
  ];
  for (const [label, lamports] of rows) {
    console.log(
      `  ${label.padEnd(9)} ${String(lamports).padStart(10)} lamports  (${sol(lamports)} SOL)`,
    );
  }
  console.log(`  Jito minimum bundle tip: ${JITO_MIN_TIP_LAMPORTS} lamports`);

  console.log('\n=== Current Jito tip accounts (from getTipAccounts) ===');
  const accounts = await getTipAccounts();
  accounts.forEach((a, i) => console.log(`  [${i}] ${a}`));

  // A naive baseline so you can feel the data: clamp the 75th percentile to the
  // minimum. The real AI agent (later) will reason over slot conditions + cost.
  const baseline = Math.max(floor.p75, JITO_MIN_TIP_LAMPORTS);
  console.log(
    `\nBaseline tip suggestion (75th pct, floored at minimum): ${baseline} lamports (${sol(baseline)} SOL)`,
  );
  console.log('\nIf you see live numbers above, your stack is wired correctly. ✅');
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
