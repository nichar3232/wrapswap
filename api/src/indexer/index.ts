import { keccak256, toHex } from "viem";
import type { Deployment } from "@wrapswap/types";
import { db, upsertDarkPairs } from "../db/index.js";
import { publicClient, loadDeployment, json } from "../chain/client.js";
import { decode, projection, accepts, deploymentTokens, darkHooks } from "./events.js";
const LOG_ADDRESS_CHUNK = 8;
export { projection } from "./events.js";
export class Indexer {
  busy = false;
  constructor(
    readonly d: Deployment,
    readonly client: any = publicClient,
    readonly pool = db,
    readonly confirmations = Number(process.env.INDEXER_CONFIRMATIONS ?? 2),
  ) {
    if (!Number.isInteger(confirmations) || confirmations < 0)
      throw Error("Invalid INDEXER_CONFIRMATIONS");
  }
  async catchup() {
    if (this.busy) return;
    this.busy = true;
    const c = await this.pool.connect().catch((e: unknown) => {
      this.busy = false;
      throw e;
    });
    try {
      await c.query("SELECT pg_advisory_lock($1)", [this.d.chainId]);
      if ((await this.client.getChainId()) !== this.d.chainId)
        throw Error("RPC chain mismatch");
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock($1)", [this.d.chainId]);
      // Views join dark rows through dark_pairs; keep it present even after a dev reset truncated every table.
      await upsertDarkPairs(this.d, c);
      const d = this.d,
        start = BigInt(d.startBlock);
      const identity = keccak256(
        toHex(
          [
            d.deployCommit,
            d.startBlock,
            d.contracts.parityHook,
            d.contracts.darkCrossHook,
          ].join("|"),
        ),
      );
      const old = (
        await c.query(
          "SELECT identity FROM indexer_deployments WHERE chain_id=$1",
          [d.chainId],
        )
      ).rows[0];
      if (old && old.identity !== identity) {
        await c.query("DELETE FROM blocks WHERE chain_id=$1", [d.chainId]);
        await c.query("DELETE FROM indexer_deployments WHERE chain_id=$1", [
          d.chainId,
        ]);
      }
      await c.query(
        "INSERT INTO indexer_deployments(chain_id,network,identity,deploy_commit,start_block) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [d.chainId, d.network, identity, d.deployCommit, d.startBlock],
      );
      let cursor = (
        await c.query("SELECT * FROM indexer_cursor WHERE chain_id=$1", [
          d.chainId,
        ])
      ).rows[0];
      const head = await this.client.getBlockNumber();
      if (cursor) {
        let height = BigInt(cursor.last_block),
          ancestor = height,
          found = false;
        for (let depth = 0; depth <= 64; depth++, ancestor--) {
          if (ancestor < start) {
            found = true;
            break;
          }
          const saved = (
            await c.query(
              "SELECT block_hash FROM blocks WHERE chain_id=$1 AND block_number=$2",
              [d.chainId, ancestor.toString()],
            )
          ).rows[0];
          if (
            ancestor <= head &&
            saved?.block_hash ===
              (await this.client.getBlock({ blockNumber: ancestor })).hash
          ) {
            found = true;
            break;
          }
        }
        if (!found)
          throw Error("Reorg exceeds 64 blocks; operator resync required");
        if (ancestor !== height) {
          await c.query(
            "DELETE FROM blocks WHERE chain_id=$1 AND block_number>$2",
            [d.chainId, ancestor.toString()],
          );
          await c.query("DELETE FROM indexer_cursor WHERE chain_id=$1", [
            d.chainId,
          ]);
          cursor =
            ancestor >= start ? { last_block: ancestor.toString() } : undefined;
          if (cursor) {
            const b = await this.client.getBlock({ blockNumber: ancestor });
            await c.query(
              "INSERT INTO indexer_cursor(chain_id,last_block,last_block_hash) VALUES($1,$2,$3)",
              [d.chainId, ancestor.toString(), b.hash],
            );
          }
        }
      }
      await c.query("COMMIT");
      const last = head - BigInt(this.confirmations);
      const addresses = [
        ...new Set(
          [
            ...Object.values(d.contracts).filter(Boolean),
            ...deploymentTokens(d).flatMap((t) => [t.address, t.adapter]),
            ...(d.faucet ? [d.faucet] : []),
            ...darkHooks(d),
          ].map((a) => String(a).toLowerCase()),
        ),
      ] as `0x${string}`[];
      for (
        let from = cursor ? BigInt(cursor.last_block) + 1n : start;
        from <= last;
        from += 2000n
      ) {
        const to = from + 1999n > last ? last : from + 1999n;
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock($1)", [d.chainId]);
        const blocks = new Map<string, any>();
        let previous =
          from > start
            ? (
                await c.query(
                  "SELECT block_hash FROM blocks WHERE chain_id=$1 AND block_number=$2",
                  [d.chainId, (from - 1n).toString()],
                )
              ).rows[0]?.block_hash
            : undefined;
        for (let n = from; n <= to; n++) {
          const b = await this.client.getBlock({ blockNumber: n });
          if (previous && b.parentHash !== previous)
            throw Error("Chain changed during indexing");
          previous = b.hash;
          blocks.set(n.toString(), b);
          await c.query(
            "INSERT INTO blocks VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
            [
              d.chainId,
              n.toString(),
              b.hash,
              b.parentHash,
              b.timestamp.toString(),
            ],
          );
        }
        // Public RPCs cap eth_getLogs address lists (publicnode: 8); query in chunks and restore chain order.
        const logs = (
          await Promise.all(
            Array.from(
              { length: Math.ceil(addresses.length / LOG_ADDRESS_CHUNK) },
              (_, i) =>
                this.client.getLogs({
                  address: addresses.slice(
                    i * LOG_ADDRESS_CHUNK,
                    (i + 1) * LOG_ADDRESS_CHUNK,
                  ),
                  fromBlock: from,
                  toBlock: to,
                }),
            ),
          )
        )
          .flat()
          .sort((x, y) =>
            x.blockNumber === y.blockNumber
              ? x.logIndex - y.logIndex
              : x.blockNumber < y.blockNumber
                ? -1
                : 1,
          );
        for (const log of logs) {
          if (log.removed) continue;
          if (!accepts(log, d)) continue;
          const e = decode(log);
          const b = blocks.get(log.blockNumber.toString());
          if (b.hash !== log.blockHash) throw Error("Log block mismatch");
          const p = {
            chain_id: d.chainId,
            block_number: log.blockNumber.toString(),
            block_hash: log.blockHash,
            block_timestamp: b.timestamp.toString(),
            tx_hash: log.transactionHash,
            log_index: log.logIndex,
            contract: log.address.toLowerCase(),
          };
          const projected = projection(e.eventName!, e.args, p, d);
          if (!projected) continue;
          await c.query(
            "INSERT INTO raw_logs VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING",
            [...Object.values(p), log.topics[0], e.eventName, json(e.args)],
          );
          await c.query(projected.sql, projected.values);
        }
        if ((await this.client.getBlock({ blockNumber: to })).hash !== previous)
          throw Error("Chain changed during window");
        await c.query(
          "INSERT INTO indexer_cursor(chain_id,last_block,last_block_hash) VALUES($1,$2,$3) ON CONFLICT(chain_id) DO UPDATE SET last_block=EXCLUDED.last_block,last_block_hash=EXCLUDED.last_block_hash,updated_at=now()",
          [d.chainId, to.toString(), previous],
        );
        await c.query("COMMIT");
      }
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      try {
        await c.query("SELECT pg_advisory_unlock($1)", [this.d.chainId]);
      } finally {
        c.release();
        this.busy = false;
      }
    }
  }
}
export function startIndexer(d = loadDeployment()) {
  const indexer = new Indexer(d);
  const run = () => indexer.catchup().catch(console.error);
  void run();
  const timer = setInterval(run, Number(process.env.INDEXER_POLL_MS ?? 1000));
  return () => clearInterval(timer);
}
