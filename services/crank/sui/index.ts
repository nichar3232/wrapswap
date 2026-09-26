// Unison Pay keeper daemon. `tsx services/crank/sui/index.ts [--once]`
import { Keeper } from './keeper.js';
import { acquireLock } from './state.js';
import { loadDeployment } from './config.js';

const once = process.argv.includes('--once');
const intervalMs = Number(process.env.SUI_KEEPER_INTERVAL_MS ?? 10_000);
const release = acquireLock(loadDeployment().sui.poolId);
process.on('exit', release);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

const keeper = new Keeper();
do {
  try {
    for (const r of await keeper.tick()) console.log(`[sui-keeper] receipt ${JSON.stringify(r)}`);
  } catch (e) {
    console.error('[sui-keeper] tick failed:', (e as Error).message);
    if (once) process.exitCode = 1;
  }
  if (!once) await new Promise((r) => setTimeout(r, intervalMs));
} while (!once);
