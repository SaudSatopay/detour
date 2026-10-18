import { describe, expect, it } from "vitest";
import { brainRecording, recordedAnswer, recordedDirectory, sameQuestion } from "./recorded";

describe("the brain's recording, for when the graph database is unreachable", () => {
  it("matches a question however it is cased or punctuated", () => {
    expect(sameQuestion("Is the elevator at Times Sq-42 St working?", "is the elevator at times sq 42 st working")).toBe(true);
    expect(sameQuestion("Who maintains elevator EL293?", "Who maintains elevator EL294?")).toBe(false);
  });

  it("answers every suggested question it shows, labeled as recorded with its date", async () => {
    const r = await brainRecording();
    expect(r).not.toBeNull();
    const directory = await recordedDirectory();
    expect(directory?.recorded?.at).toBe(r!.recordedAt);
    expect(directory?.history).toEqual([]);
    for (const q of directory!.suggestions) {
      const a = await recordedAnswer(q);
      expect(a?.mode).toBe("recorded");
      expect(a?.sources.length).toBeGreaterThan(0);
      expect(a?.note).toMatch(/unreachable right now.*recorded on/);
    }
    expect(await recordedAnswer("What is the capital of France?")).toBeNull();
  });
});
