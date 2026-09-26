// The keeper's plaintext ledger. Lives in ~/wrapswap-run/sui-state/, never in the repo: it is exactly what Seal
// hides from everyone else.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './config.js';

export type PendingWithdrawal = {
  commitment: `0x${string}`;
  owner: string;
  recipient: `0x${string}`;
  target: `0x${string}`;
  shares: string;
  maxFeeBps: number;
  reserved: string;
  seq: number;
};

export type LogEntry = { at: string; event: string; [k: string]: unknown };

export type KeeperState = {
  pool: string;
  /** owner (normalized Sui address) -> canonical shares, decimal string. Owners stay listed at zero. */
  balances: Record<string, string>;
  total: string;
  seenCommitments: string[];
  pending: PendingWithdrawal[];
  credited: string[];
  evmFromBlock: string | null;
  lastAppliedSeq: number;
  log: LogEntry[];
};

const file = (pool: string) => join(STATE_DIR, `state-${pool.slice(2, 10)}.json`);

export function loadState(pool: string): KeeperState {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const f = file(pool);
  if (!existsSync(f)) {
    return { pool, balances: {}, total: '0', seenCommitments: [], pending: [], credited: [], evmFromBlock: null, lastAppliedSeq: 0, log: [] };
  }
  return JSON.parse(readFileSync(f, 'utf8'));
}

export function saveState(s: KeeperState) {
  const f = file(s.pool);
  writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 1), { mode: 0o600 });
  renameSync(`${f}.tmp`, f);
}

export function log(s: KeeperState, event: string, fields: Record<string, unknown> = {}) {
  const e = { at: new Date().toISOString(), event, ...fields };
  s.log.push(e);
  if (s.log.length > 500) s.log.splice(0, s.log.length - 500);
  if (!process.env.SUI_KEEPER_QUIET) console.log(`[sui-keeper] ${event} ${JSON.stringify(fields)}`);
}

/** One keeper per pool: the demo and the daemon must not both drive the same ledger. */
export function acquireLock(pool: string): () => void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const f = join(STATE_DIR, `keeper-${pool.slice(2, 10)}.lock`);
  if (existsSync(f)) {
    const pid = Number(readFileSync(f, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive && pid !== process.pid) throw new Error(`keeper lock held by pid ${pid} (${f})`);
    unlinkSync(f);
  }
  const fd = openSync(f, 'wx');
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return () => {
    try {
      unlinkSync(f);
    } catch {}
  };
}
