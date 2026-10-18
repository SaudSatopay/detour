import { afterEach, describe, expect, it } from "vitest";
import { POST } from "./route";

const post = (body: unknown) => POST(new Request("http://localhost/api/eval", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

describe("POST /api/eval", () => {
  const before = process.env.EVAL_ENABLED;
  afterEach(() => {
    if (before === undefined) delete process.env.EVAL_ENABLED;
    else process.env.EVAL_ENABLED = before;
  });

  it("does nothing unless the owner sets EVAL_ENABLED=1", async () => {
    for (const value of [undefined, "", "0", "true", "yes"]) {
      if (value === undefined) delete process.env.EVAL_ENABLED;
      else process.env.EVAL_ENABLED = value;
      const res = await post({ start: true });
      expect(res.status).toBe(403);
    }
  });

  it("accepts only {} or { start: true }", async () => {
    process.env.EVAL_ENABLED = "1";
    expect((await post({ start: "yes" })).status).toBe(400);
    expect((await post({ arms: ["graph"] })).status).toBe(400);
  });
});
