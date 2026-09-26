import { it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { abis } from "@wrapswap/types";
import { decodeFunctionData, encodeFunctionResult } from "viem";
import { deployment, chainMock, hash } from "./fixtures.js";
it("API and crank start as separate processes with documented env alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "wrapswap-startup-"));
  mkdirSync(join(root, "deployments"));
  writeFileSync(
    join(root, "deployments/anvil.json"),
    JSON.stringify(deployment),
  );
  const mock = chainMock();
  const children: ChildProcess[] = [];
  let logs = "";
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const answer = async (r: any) => {
      try {
        let result: any;
        if (r.method === "eth_chainId") result = "0x7a69";
        else if (r.method === "eth_blockNumber") result = "0x1";
        else if (r.method === "eth_getTransactionCount") result = "0x0";
        else if (r.method === "eth_getLogs") result = [];
        else if (r.method === "eth_getBlockByNumber")
          result = {
            number: "0x1",
            hash: hash(1),
            parentHash: hash(0),
            timestamp: "0x6aba7f68",
            transactions: [],
            gasLimit: "0x1c9c380",
            gasUsed: "0x0",
            size: "0x0",
            difficulty: "0x0",
            totalDifficulty: "0x0",
            extraData: "0x",
            miner: deployment.deployer,
            nonce: "0x0000000000000000",
            baseFeePerGas: "0x1",
          };
        else if (r.method === "eth_call") {
          let found = false;
          for (const abi of Object.values(abis)) {
            let call: any;
            try {
              call = decodeFunctionData({ abi, data: r.params[0].data });
            } catch {
              continue;
            }
            const value =
              call.functionName === "participants"
                ? []
                : call.functionName === "getMid"
                  ? [1012500000000000000n, 1790607208n]
                  : await mock.readContract({
                      address: r.params[0].to,
                      ...call,
                    });
            result = encodeFunctionResult({
              abi,
              functionName: call.functionName,
              result: value,
            } as any);
            found = true;
            break;
          }
          if (!found) throw Error("Unknown call");
        } else throw Error("Unsupported " + r.method);
        return { jsonrpc: "2.0", id: r.id, result };
      } catch (e) {
        return {
          jsonrpc: "2.0",
          id: r.id,
          error: { code: -32000, message: String(e) },
        };
      }
    };
    res.setHeader("content-type", "application/json");
    const request = JSON.parse(body);
    res.end(
      JSON.stringify(
        Array.isArray(request)
          ? await Promise.all(request.map(answer))
          : await answer(request),
      ),
    );
  });
  const rpcPort = Number(process.env.ANVIL_PORT ?? 18504),
    apiPort = Number(process.env.API_PORT ?? 18004),
    crankPort = Number(process.env.CRANK_HEALTH_PORT ?? 18104);
  await new Promise<void>((r) => server.listen(rpcPort, "127.0.0.1", r));
  try {
    const env = {
      ...process.env,
      NETWORK: "anvil",
      RPC_URL: `http://127.0.0.1:${rpcPort}`,
      API_PORT: String(apiPort),
      CRANK_HEALTH_PORT: String(crankPort),
      ORACLE_MODE: "external",
      INDEXER_CONFIRMATIONS: "0",
    };
    for (const entry of ["api/src/index.ts", "services/crank/index.ts"]) {
      const child = spawn(
        process.execPath,
        [resolve("node_modules/tsx/dist/cli.mjs"), resolve(entry)],
        { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      children.push(child);
      child.stdout?.on("data", (x) => (logs += x));
      child.stderr?.on("data", (x) => (logs += x));
    }
    for (const [port, path] of [
      [apiPort, "/health"],
      [crankPort, "/health"],
    ] as const) {
      let response: any;
      for (let n = 0; n < 80; n++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}${path}`);
          response = await r.json();
          if (response.ok) break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(response?.ok, logs).toBe(true);
    }
    const proxy = await fetch(`http://127.0.0.1:${apiPort}/status`);
    expect(proxy.status).toBe(200);
    expect(((await proxy.json()) as any).network).toBe("anvil");
  } finally {
    for (const child of children) {
      child.kill("SIGTERM");
      await new Promise<void>((r) => {
        if (child.exitCode !== null) return r();
        child.once("exit", () => r());
        setTimeout(() => {
          child.kill("SIGKILL");
          r();
        }, 2000).unref();
      });
    }
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true });
  }
}, 20000);
