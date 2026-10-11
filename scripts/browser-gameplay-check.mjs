import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentClient, pause } from "./agent-client.ts";

// The environment supplies the fallback CDP helper; no browser dependency is installed.
assert.ok(
  process.env.BROWSER_CDP_HELPER,
  "Set BROWSER_CDP_HELPER to the fallback skill's cdp.mjs",
);
const { openPage } = await import(pathToFileURL(process.env.BROWSER_CDP_HELPER).href);
const page = await openPage({ width: 1280, height: 900 });
const browserUrl = process.env.BROWSER_GAME_URL || "http://172.17.0.1:35267/";
const serverUrl = process.env.GAME_URL || "http://127.0.0.1:35267/";
const output = resolve(process.env.BROWSER_OUTPUT || "/tmp/afterhours-gameplay-check");
await mkdir(output, { recursive: true });
let buddy;
async function until(expression, message, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.evaluate(expression)) return;
    await pause(200);
  }
  throw Error(
    `${message}: ${JSON.stringify(await page.evaluate('({loading:document.querySelector("#loading")?.textContent,toast:document.querySelector("#toast")?.textContent})'))}`,
  );
}
try {
  await page.navigate(browserUrl, 1000);
  await until(
    'document.querySelector("#play") && !document.querySelector("#play").disabled',
    "City did not become playable",
  );
  await page.evaluate(
    'document.querySelector("#name").value="Browser pilot"; document.querySelector("#join").requestSubmit()',
  );
  await until("!!window.afterhoursDebug", "Debug-enabled browser join failed");
  await page.evaluate(
    'document.querySelector("#name").blur();document.activeElement?.blur()',
  );
  buddy = await AgentClient.connect(serverUrl, "Nameplate buddy");
  await until(
    'document.querySelector(".nameplate")?.textContent==="Nameplate buddy"',
    "Observer nameplate absent",
  );
  await writeFile(resolve(output, "names.png"), await page.screenshot());
  await buddy.command({ kind: "teleport", x: 6, z: 26 });
  await pause(150);
  buddy.send({ type: "interact" });
  await until(
    'window.afterhoursDebug.inspect().entities.some(e=>e.name==="Nameplate buddy" && e.vehicle)',
    "Buddy did not board",
  );
  await until(
    'document.querySelector(".nameplate")?.textContent==="Nameplate buddy"',
    "Seated nameplate absent",
  );
  await writeFile(resolve(output, "seated-name.png"), await page.screenshot());
  buddy.close();
  buddy = undefined;
  await until(
    '!document.querySelector(".nameplate")',
    "Disconnected nameplate remained",
  );
  await page.evaluate("window.afterhoursDebug.move({up:true},1)");
  const state = await page.evaluate("window.afterhoursDebug.inspect()");
  assert.ok(state.player.health > 0);
  assert.ok(Number.isFinite(state.predicted?.x));
  await writeFile(resolve(output, "street.png"), await page.screenshot());
  assert.equal(
    page.logs.filter((line) => line.startsWith("exception")).length,
    0,
    page.logs.join("\n"),
  );
  await writeFile(
    resolve(output, "result.json"),
    JSON.stringify({ viewport: [1280, 900], state, logs: page.logs }, null, 2),
  );
  console.log(`Browser gameplay verified; captures in ${output}`);
} finally {
  buddy?.close();
  await page.close();
}
