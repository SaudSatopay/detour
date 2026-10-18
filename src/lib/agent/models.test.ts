import { describe, expect, it } from "vitest";
import { chainSpecs, classify, nextPacificMidnight } from "./models";

describe("the model chain", () => {
  it("tries several free models in order, Gemini before Groq", () => {
    const specs = chainSpecs({});
    expect(specs[0]).toBe("google:gemini-flash-latest");
    expect(specs.filter((s) => s.startsWith("google:")).length).toBeGreaterThan(1);
    expect(specs.findIndex((s) => s.startsWith("groq:"))).toBeGreaterThan(specs.findLastIndex((s) => s.startsWith("google:")));
  });

  it("takes a whole list from AGENT_MODELS, or puts a primary first without repeats", () => {
    expect(chainSpecs({ AGENT_MODELS: "groq:a, google:b" })).toEqual(["groq:a", "google:b"]);
    const specs = chainSpecs({ AGENT_MODEL_PRIMARY: "google:gemini-2.5-flash" });
    expect(specs[0]).toBe("google:gemini-2.5-flash");
    expect(specs.filter((s) => s === "google:gemini-2.5-flash")).toHaveLength(1);
  });
});

describe("why a model failed", () => {
  it("knows a spent daily quota from Gemini's quota id, even inside a retry error", () => {
    const wrapped = {
      message: "Failed after 2 attempts. Last error: Resource exhausted",
      lastError: { statusCode: 429, message: "Resource exhausted", responseBody: '{"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"}' },
    };
    expect(classify(wrapped)).toBe("daily");
  });

  it("knows Groq's daily token cap", () => {
    expect(classify({ statusCode: 429, message: "Rate limit reached for model on tokens per day (TPD): Limit 200000" })).toBe("daily");
  });

  it("takes a retired or unknown model out of the chain instead of failing the run", () => {
    expect(classify({ statusCode: 404, message: "models/gemini-2.0-pro is not found for API version v1beta" })).toBe("missing");
    expect(classify({ statusCode: 400, message: "The model `llama-x` has been decommissioned" })).toBe("missing");
  });

  it("treats a per-minute limit or an overload as worth retrying soon", () => {
    expect(classify({ statusCode: 429, message: "Please retry in 41.2s." })).toBe("rate");
    expect(classify({ statusCode: 503, message: "The model is overloaded" })).toBe("rate");
  });

  it("leaves real errors alone", () => {
    expect(classify({ statusCode: 400, message: "Invalid JSON payload received" })).toBe("other");
  });
});

describe("Gemini's daily reset", () => {
  it("is the next midnight in Los Angeles", () => {
    // 2026-10-19 07:00 UTC is 00:00 PDT, so the next reset is 2026-10-20 07:00 UTC (plus a minute).
    const now = Date.UTC(2026, 9, 19, 12, 30);
    expect(new Date(nextPacificMidnight(now)).toISOString()).toBe("2026-10-20T07:01:00.000Z");
  });
});
