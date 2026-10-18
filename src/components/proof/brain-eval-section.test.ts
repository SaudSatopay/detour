import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import report from "../../../data/eval/brain.json";
import { BrainEvalSection } from "./brain-eval-section";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

describe("BrainEvalSection", () => {
  const html = renderToStaticMarkup(createElement(BrainEvalSection));

  it("leads with the held-out scores of the graph tools and the keyword baseline", () => {
    expect(html).toContain(`of ${report.overall.graph.em.n.toLocaleString("en-US")} held-out questions`);
    expect(html).toContain("Keyword retrieval");
    expect(html).toContain("Latest snapshot only");
  });
  it("lists every question type with held-out questions, and examples with each arm's answer", () => {
    for (const t of report.byType.filter((x) => x.n > 0)) expect(html).toContain(escape(t.label));
    expect(html).toContain(escape(report.heldout[0].question));
  });
});
