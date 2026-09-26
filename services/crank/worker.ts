import {
  abis,
  canonical,
  type Deployment,
  type CrankStatusResponse,
} from "@wrapswap/types";
import { parseAbi } from "viem";
import { chainReader, contractAbis } from "../../api/src/chain/client.js";
export const retryDelay = (attempt: number, random = Math.random) =>
  Math.min(
    30_000,
    1000 * 2 ** Math.min(attempt, 5) + Math.floor(random() * 1000),
  );
export class Crank {
  busy = false;
  attempt = 0;
  actionAttempts = new Map<string, number>();
  lastProcessed: bigint | null = null;
  readonly status: CrankStatusResponse;
  readonly read;
  constructor(
    readonly d: Deployment,
    readonly client: any,
    readonly wallet: any,
    readonly account: any,
    readonly oracleMode = "mock",
  ) {
    this.read = chainReader(d, client);
    this.status = {
      ok: false,
      network: d.network,
      chainId: d.chainId,
      signer: account.address,
      lastBlock: null,
      lastSettle: null,
      lastOraclePush: null,
      lastPegCheck: null,
      lastError: "Starting",
    };
  }
  async recoverPending(
    now = Date.now,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ) {
    const deadline = now() + 60_000;
    while (true) {
      const latest = await this.client.getTransactionCount({
        address: this.account.address,
        blockTag: "latest",
      });
      const pending = await this.client.getTransactionCount({
        address: this.account.address,
        blockTag: "pending",
      });
      // Only pending > latest means a stuck tx; some public RPCs (Unichain Sepolia) report a stale pending count below latest.
      if (pending <= latest) return;
      if (now() < deadline) {
        await sleep(1000);
        continue;
      }
      const gasPrice = await this.client.getGasPrice();
      const hash = await this.wallet.sendTransaction({
        account: this.account,
        chain: null,
        to: this.account.address,
        value: 0n,
        nonce: latest,
        gas: 21000n,
        gasPrice: (gasPrice * 120n) / 100n,
      });
      const receipt = await this.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw Error("Pending nonce replacement reverted");
    }
  }
  async send(contract: string, functionName: string, args: any[]) {
    const request = {
      account: this.account,
      address: this.d.contracts[contract as keyof Deployment["contracts"]],
      abi: contractAbis[contract],
      functionName,
      args,
    };
    const action =
      contract +
      functionName +
      JSON.stringify(args, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      );
    try {
      await this.client.simulateContract(request);
      const gasPrice =
        ((await this.client.getGasPrice()) *
          BigInt(
            100 + Math.min(this.actionAttempts.get(action) ?? 0, 5) * 20,
          )) /
        100n;
      // The loop sends one tx at a time, so max(latest, pending) is the next nonce even when pending is stale.
      const [latest, pending] = await Promise.all(
        (["latest", "pending"] as const).map((blockTag) =>
          this.client.getTransactionCount({ address: this.account.address, blockTag }),
        ),
      );
      const hash = await this.wallet.writeContract({
        ...request,
        chain: null,
        gasPrice,
        nonce: Math.max(latest, pending),
      });
      // The loop remains busy until this receipt resolves. On restart recoverPending fences the nonce.
      const receipt = await this.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw Error(`${functionName} reverted: ${hash}`);
      this.actionAttempts.delete(action);
      return hash;
    } catch (e) {
      this.actionAttempts.set(
        action,
        (this.actionAttempts.get(action) ?? 0) + 1,
      );
      throw e;
    }
  }
  async oracle(b: any, settling = false) {
    if (!this.d.mockOracle || this.oracleMode !== "mock") return;
    const base = this.d.tokens.find((t) => t.darkRole === "base")!,
      quote = this.d.tokens.find((t) => t.darkRole === "quote")!;
    const ratios = await Promise.all(
      [base, quote].map((t) =>
        this.client.readContract({
          address: t.adapter,
          abi: abis.IWrapperAdapter,
          functionName: "sharesPerToken",
        }),
      ),
    );
    const mid = canonical.parityPriceX18(ratios[0], ratios[1]);
    let push = false;
    try {
      const [stored, updated] = await this.read("oracle", "getMid", [
        base.address,
        quote.address,
      ]);
      const age = b.timestamp - updated;
      const max = BigInt(await this.read("darkCrossHook", "ORACLE_MAX_AGE"));
      push = stored !== mid || age >= 300n || (settling && age >= max - 60n);
    } catch (e) {
      if (!String(e).includes("NoPrice")) throw e;
      push = true;
    }
    if (push) {
      const txHash = await this.send("oracle", "setMid", [
        base.address,
        quote.address,
        mid,
      ]);
      this.status.lastOraclePush = { midX18: mid.toString(), txHash };
      this.log("oracle_push", this.status.lastOraclePush);
    }
  }
  log(event: string, fields: any) {
    console.log(JSON.stringify({ event, ...fields }));
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      if ((await this.client.getChainId()) !== this.d.chainId)
        throw Error("RPC chain mismatch");
      await this.recoverPending();
      const b = await this.client.getBlock();
      if (this.lastProcessed === b.number && !this.status.lastError) return;
      this.status.lastBlock = b.number.toString();
      await this.oracle(b);
      const [current, phase] = await this.read("darkCrossHook", "currentBatch");
      for (
        let id = current > 16n ? current - 16n : 0n;
        id < current || (id === current && Number(phase) === 2);
        id++
      ) {
        if (await this.read("darkCrossHook", "settled", [id])) continue;
        if (!(await this.read("darkCrossHook", "participants", [id])).length)
          continue;
        await this.oracle(await this.client.getBlock(), true);
        try {
          const txHash = await this.send("darkCrossHook", "settle", [id]);
          this.status.lastSettle = { batchId: id.toString(), txHash };
          this.log("settled", this.status.lastSettle);
        } catch (e) {
          if (!String(e).includes("AlreadySettled")) throw e;
        }
      }
      const swaps = await this.client.getLogs({
        address: this.d.contracts.poolManager,
        event: parseAbi([
          "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)",
        ])[0],
        args: { id: this.d.pool.id },
        fromBlock: b.number,
        toBlock: b.number,
      });
      if (b.number % 10n === 0n || swaps.length) {
        const [peg, old] = await Promise.all([
          this.read("parityHook", "pegStatus", [this.d.pool.key]),
          this.read("parityHook", "pegTripped", [this.d.pool.id]),
        ]);
        if (peg.tripped !== old) {
          const txHash = await this.send("parityHook", "checkPeg", [
            this.d.pool.key,
          ]);
          this.status.lastPegCheck = { tripped: peg.tripped, txHash };
          this.log("peg_check", this.status.lastPegCheck);
        }
      }
      this.lastProcessed = b.number;
      this.status.lastError = null;
      this.status.ok = true;
      this.attempt = 0;
    } catch (e) {
      this.attempt++;
      this.status.lastError = String(e);
      this.status.ok = false;
      this.log("error", { message: String(e) });
    } finally {
      this.busy = false;
    }
  }
}
