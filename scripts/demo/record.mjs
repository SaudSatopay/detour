/**
 * Records the demo video: the L closure in the control room, the approval and rider advisories, memory
 * changing a route, and the proof. Captions are drawn into the page in the site's own type, then
 * ffmpeg encodes the result as H.264.
 *
 *   node scripts/demo/record.mjs <base url> [out.mp4]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { chromium } from "@playwright/test";

const base = process.argv[2] ?? "http://localhost:3000";
const out = process.argv[3] ?? "docs/demo.mp4";
const tmp = ".missile/video";
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: tmp, size: { width: 1440, height: 900 } },
  colorScheme: "light",
});
const page = await context.newPage();
const pause = (s) => page.waitForTimeout(s * 1000);
const seen = (t) => page.getByText(t).filter({ visible: true });

/** A caption bar in the station-sign style, bottom center. */
async function caption(title, detail = "") {
  await page.evaluate(
    ([t, d]) => {
      let el = document.getElementById("demo-caption");
      if (!el) {
        el = document.createElement("div");
        el.id = "demo-caption";
        el.style.cssText =
          "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;max-width:980px;padding:14px 22px;border-radius:6px;background:var(--sign);color:var(--sign-ink);box-shadow:0 10px 30px rgb(0 0 0/.25);transition:opacity 200ms ease-out";
        document.body.appendChild(el);
      }
      el.style.opacity = t ? "1" : "0";
      el.innerHTML = t
        ? `<div style="font-family:var(--font-display);font-weight:700;font-size:28px;line-height:1.1;letter-spacing:.01em">${t}</div>${
            d ? `<div style="font-family:var(--font-sans);font-size:17px;line-height:1.4;margin-top:6px;opacity:.85">${d}</div>` : ""
          }`
        : "";
    },
    [title, detail],
  );
}

// 1. The claim, over the landing map.
await page.goto(base, { waitUntil: "networkidle" });
await caption("Detour", "When a New York subway line breaks, agents on a FalkorDB graph measure what the city can still carry.");
await pause(6);

// 2. The control room: the L closes at 8 a.m.
await page.goto(`${base}/control?scenario=l-canarsie`, { waitUntil: "networkidle" });
await caption("A dispatcher reports the L is down", "The controller agent works on its own copy of the graph, made with GRAPH.COPY.");
await pause(3);
await page.getByRole("button", { name: "Run the controller" }).click();
await pause(2);
await caption("Every step is a tool call on FalkorDB", "Each answer has a shape, a summary and the Cypher that produced it.");
await seen("Who rides through it").first().waitFor({ timeout: 60_000 });
await pause(2);
await caption("23,445 riders an hour cross the closure", "Only 7,823 board at the closed stations. Riders up to four stops away are hit too.");
await seen("Brief for the dispatcher").waitFor({ timeout: 90_000 });
await page.getByRole("button", { name: /Measure capacity/ }).filter({ visible: true }).first().click();
await pause(1.5);
await caption("Their fastest way around overloads the G at 244%", "algo.maxFlow on spare capacity: 93% can still move; the min cut is at 1 Av, where the L is the only line.");
await pause(7);
await page
  .getByText(/^Cypher ·/)
  .filter({ visible: true })
  .nth(4)
  .click()
  .catch(() => undefined);
await pause(4);
await page.getByRole("button", { name: /Simulate a plan/ }).filter({ visible: true }).first().click();
await caption("A shuttle tested on a forked graph", "1 Av to Astor Pl: riders with no path 4,689 → 623. Memory said past buses carried 79% of plan, so it adds 27% more.");
await pause(7);

// 3. Approval and the rider desk.
await page.getByRole("button", { name: "Follow the latest step" }).click().catch(() => undefined);
await page.getByRole("button", { name: "Approve and publish to riders" }).filter({ visible: true }).first().click();
await caption("A person approves; the controller hands off", "The rider desk runs one agent per remembered rider whose trip crosses the closure.");
await pause(9);

// 4. Memory changes an answer.
await context.clearCookies();
await page.goto(`${base}/riders?rider=aisha`, { waitUntil: "networkidle" });
await caption("Memory lives in the graph", "Aisha uses a wheelchair. Memory says the L elevator at Myrtle-Wyckoff Avs has been out since Oct 14.");
await pause(4);
const route = page.getByRole("button", { name: "Route Aisha now" });
if (await route.isEnabled()) {
  await route.click();
  await pause(3);
  await page.getByRole("button", { name: "Report the L elevator fixed" }).click();
  await caption("Report it fixed: the old fact is closed, not deleted", "Her next step-free route takes the L: 24 minutes instead of 33.");
  await pause(7);
  await page.getByRole("button", { name: "Report it out of service again" }).click();
  await pause(1);
} else {
  await pause(4);
}

// 5. Proof.
await page.goto(`${base}/proof`, { waitUntil: "networkidle" });
await page.locator("#agreement").scrollIntoViewIfNeeded();
await page.evaluate(() => window.scrollBy(0, -90));
await caption("Every number is checked twice", "FalkorDB and an independent NetworkX program agree on every closure. 7,195 reads/s across tenant graphs.");
await pause(7);

await caption("Detour", `${base.replace(/^https?:\/\//, "")} · Graph Hacks · FalkorDB · Tracks 1 and 2`);
await pause(4);

await context.close();
await browser.close();

const webm = readdirSync(tmp).find((f) => f.endsWith(".webm"));
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", `${tmp}/${webm}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", "-preset", "slow", "-movflags", "+faststart", out], {
  stdio: "inherit",
});
console.log(`wrote ${out}`);
