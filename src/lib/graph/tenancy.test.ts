import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyGraph } from "./db";
import { graphExists, holdSandbox, releaseSandbox, sandboxEntries, touchSandbox } from "./meta";
import { FORK_PREFIX, sandboxGraph } from "./names";
import { ensureBaseGraphs } from "./seed";
import { dropSandbox, ensureSandbox, HOLD_MS, isDatabaseFull, makeRoom } from "./tenancy";

describe("isDatabaseFull", () => {
  it("recognizes FalkorDB at its memory limit", () => {
    expect(isDatabaseFull(new Error("OOM command not allowed when used memory > 'maxmemory'."))).toBe(true);
    expect(isDatabaseFull(new Error("GRAPH.COPY failed, could not fork"))).toBe(true);
  });
  it("leaves other errors alone", () => {
    expect(isDatabaseFull(new Error("Invalid input 'X': expected MATCH"))).toBe(false);
    expect(isDatabaseFull("connect ECONNREFUSED")).toBe(false);
  });
});

/* Integration: holds against a live FalkorDB (skipped when FALKORDB_URL is unset). */
describe.skipIf(!process.env.FALKORDB_URL)("sandbox holds on a live FalkorDB", () => {
  const [idle, held, me] = ["holdtestidle01", "holdtestheld01", "holdtestself01"];
  const fork = (id: string) => `${FORK_PREFIX}${id}:test`;
  const entry = async (id: string) => (await sandboxEntries()).find((e) => e.id === id);

  beforeAll(async () => {
    await ensureBaseGraphs(() => undefined, false);
    for (const id of [idle, held, me]) await ensureSandbox(id);
  }, 180_000);

  afterAll(async () => {
    for (const id of [idle, held, me]) await dropSandbox(id).catch(() => undefined);
  });

  it("counts holds, releases them one at a time, and lets an abandoned one lapse", async () => {
    await holdSandbox(held, HOLD_MS);
    await holdSandbox(held, HOLD_MS);
    await releaseSandbox(held);
    expect((await entry(held))?.held).toBe(true);
    await releaseSandbox(held);
    expect((await entry(held))?.held).toBe(false);
    await holdSandbox(held, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await entry(held))?.held).toBe(false);
  });

  it("makes room from idle sandboxes only, never one a request holds or its forks", async () => {
    // Both look long unused; only one is held by a request in flight.
    await touchSandbox(idle, 0);
    await touchSandbox(held, 1);
    await holdSandbox(held, HOLD_MS);
    await touchSandbox(held, 1);
    await copyGraph(sandboxGraph(idle), fork(idle));
    await copyGraph(sandboxGraph(held), fork(held));

    await makeRoom(me);
    expect(await graphExists(sandboxGraph(held))).toBe(true);
    expect(await graphExists(fork(held))).toBe(true);
    expect(await graphExists(sandboxGraph(idle))).toBe(false);
    expect(await graphExists(fork(idle))).toBe(false);
    expect(await graphExists(sandboxGraph(me))).toBe(true);
    await releaseSandbox(held);
  }, 120_000);
});
