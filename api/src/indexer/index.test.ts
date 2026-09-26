import { it, expect } from "vitest";
import { topics } from "@wrapswap/types";
import { decode, projection, eventNames } from "./events.js";
import { deployment, fixture } from "../testing/fixtures.js";
for (const [key, topic] of Object.entries(topics))
  it(`decodes and projects ${key}`, () => {
    const name = key.split(".")[1],
      log = fixture(name),
      e = decode(log);
    expect(log.topics[0]).toBe(topic);
    expect(e.eventName).toBe(name);
    const p = projection(name, e.args, { contract: log.address }, deployment);
    expect(p?.sql).toContain("INSERT INTO");
  });
it("covers all 32 frozen events", () => expect(eventNames).toHaveLength(32));
it("ignores denials not called by deployment hooks", () =>
  expect(
    projection(
      "EligibilityDenied",
      { caller: deployment.deployer },
      {},
      deployment,
    ),
  ).toBeNull());
it("retries after a database connection outage", async () => {
  const { Indexer } = await import("./index.js");
  let calls = 0;
  const indexer = new Indexer(deployment, {}, {
    connect: async () => {
      calls++;
      throw Error("DB down");
    },
  } as any);
  await expect(indexer.catchup()).rejects.toThrow("DB down");
  await expect(indexer.catchup()).rejects.toThrow("DB down");
  expect(calls).toBe(2);
  expect(indexer.busy).toBe(false);
});
