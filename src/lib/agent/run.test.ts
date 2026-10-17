import { describe, expect, it } from "vitest";
import { isDailyQuota, retryDelayMs } from "./run";

describe("waiting out a rate limit", () => {
  it("waits as long as Gemini asks in its message", () => {
    expect(retryDelayMs({ message: "You exceeded your current quota. Please retry in 41.2s." }, 0)).toBe(41_200);
  });

  it("reads Gemini's RetryInfo from the response body", () => {
    expect(retryDelayMs({ message: "Resource exhausted", responseBody: '{"details":[{"retryDelay": "17s"}]}' }, 0)).toBe(17_000);
  });

  it("prefers a Retry-After header", () => {
    expect(retryDelayMs({ message: "Please retry in 41s", responseHeaders: { "retry-after": "12" } }, 0)).toBe(12_000);
  });

  it("backs off when the provider gives no wait", () => {
    expect(retryDelayMs({ message: "429 Too Many Requests" }, 0)).toBe(5_000);
    expect(retryDelayMs({ message: "429 Too Many Requests" }, 1)).toBe(10_000);
  });
});

describe("a daily quota", () => {
  it("is recognized, so the run fails over instead of waiting", () => {
    expect(isDailyQuota({ message: "Quota exceeded", responseBody: '{"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"}' })).toBe(true);
    expect(isDailyQuota({ message: "Please retry in 41.2s." })).toBe(false);
  });
});
