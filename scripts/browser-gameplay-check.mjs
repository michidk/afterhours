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
const viewport = [
  Number(process.env.BROWSER_WIDTH || 1280),
  Number(process.env.BROWSER_HEIGHT || 900),
];
assert.ok(viewport.every((n) => Number.isInteger(n) && n > 0 && n <= 8192));
const page = await openPage({ width: viewport[0], height: viewport[1] });
const browserUrl = process.env.BROWSER_GAME_URL || "http://172.17.0.1:35267/";
const serverUrl = process.env.GAME_URL || "http://127.0.0.1:35267/";
const output = resolve(process.env.BROWSER_OUTPUT || "/tmp/afterhours-gameplay-check");
await mkdir(output, { recursive: true });
const startedAt = new Date().toISOString();
const aircraftOnly =
  process.argv.includes("--aircraft-only") || process.argv.includes("--planes-only");
let buddy;
const evidence = {};
async function capture(name) {
  evidence[name] = await page.evaluate("window.afterhoursDebug.inspect()");
  await writeFile(resolve(output, `${name}.png`), await page.screenshot());
  await writeFile(resolve(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`Captured ${name}`);
}
async function action(type) {
  await pause(160);
  await page.evaluate(`window.afterhoursDebug.action(${JSON.stringify(type)})`);
  await pause(160);
}
async function transportCapture(name) {
  await page.evaluate(
    '(()=>{const d=window.afterhoursDebug,p=d.inspect().player;d.camera("free",{x:p.x,y:Math.max(0,p.y),z:p.z});d.zoom(Math.log(42/d.scene.debugCamera.distance)/0.001);return d.settle()})()',
  );
  await capture(name);
  await page.evaluate('window.afterhoursDebug.camera("follow")');
}
async function grant(kind) {
  await pause(160);
  await page.evaluate(
    `window.afterhoursDebug.network.send({type:"debug",kind:${JSON.stringify(kind)}})`,
  );
  await until(
    `window.afterhoursDebug.inspect().player.${kind === "jetpack" ? "jetpack" : `weapon===${JSON.stringify(kind)}`}`,
    `Grant ${kind} absent`,
  );
}
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
  if (!process.argv.includes("--transport-only") && !aircraftOnly) {
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
    await page.evaluate("window.afterhoursDebug.time(12,0)");
    await page.evaluate("window.afterhoursDebug.teleport(-808,-140)");
    for (const weapon of ["knife", "machinegun", "flamethrower", "grenade"]) {
      await grant(weapon);
      await page.evaluate("window.afterhoursDebug.move({attack:true,aim:0},0.25)");
      if (weapon === "grenade") {
        await until(
          "window.afterhoursDebug.scene.grenadeNodes.size>0",
          "Thrown grenade absent",
        );
        await capture(weapon);
        await until(
          "window.afterhoursDebug.scene.grenadeNodes.size===0",
          "Grenade did not detonate",
        );
      } else await capture(weapon);
      await action("drop");
      await until(
        `window.afterhoursDebug.inspect().player.weapon!==${JSON.stringify(weapon)}`,
        "Drop did not clear held weapon",
      );
    }
    // Pick up the dropped grenade through the same interaction used by players.
    await action("interact");
    await until(
      "window.afterhoursDebug.inspect().player.inventory.length>1",
      "Ordinary pickup failed",
    );
    await grant("jetpack");
    await action("jetpack");
    await page.evaluate("void window.afterhoursDebug.move({ascend:true},10)");
    await until("window.afterhoursDebug.inspect().player.y>25", "Jetpack did not lift");
    await capture("jetpack");
    await page.evaluate("window.afterhoursDebug.stop()");
    await until(
      "window.afterhoursDebug.inspect().player.parachute",
      "Jetpack release did not deploy parachute",
    );
    await capture("parachute");
    await until(
      "window.afterhoursDebug.inspect().player.y===0",
      "Parachute did not land",
    );
    assert.ok(evidence.jetpack.player.jetpack.fuel < 45);
    await action("drop");
    await until(
      "!window.afterhoursDebug.inspect().player.jetpack",
      "Jetpack drop failed",
    );
  }
  await page.evaluate("window.afterhoursDebug.time(12,0)");
  if (!aircraftOnly) {
    await page.evaluate("window.afterhoursDebug.teleport(-819.5,-48)");
    await action("interact");
    await until(
      "window.afterhoursDebug.inspect().player.vehicle",
      "Boat boarding failed",
    );
    await page.evaluate("window.afterhoursDebug.move({up:true},2)");
    await transportCapture("boat");
    assert.equal(
      evidence.boat.entities.find((e) => e.id === evidence.boat.player.vehicle).kind,
      "boat",
    );
    await page.evaluate("window.afterhoursDebug.move({right:true,up:true},1)");
    await page.evaluate("window.afterhoursDebug.move({brake:true},2)");
    await action("interact");
    await until("!window.afterhoursDebug.inspect().player.vehicle", "Boat exit failed");
    for (const [kind, z] of [
      ["jetski", -16],
      ["speedboat", 16],
    ]) {
      await page.evaluate(`window.afterhoursDebug.teleport(-827,${z})`);
      await action("interact");
      await until(
        `window.afterhoursDebug.inspect().entities.some(e=>e.id===window.afterhoursDebug.inspect().player.vehicle && e.kind===${JSON.stringify(kind)})`,
        `${kind} boarding failed`,
      );
      await page.evaluate("window.afterhoursDebug.move({up:true},2)");
      await transportCapture(kind);
      await page.evaluate("window.afterhoursDebug.move({up:true,right:true},0.8)");
      await page.evaluate("window.afterhoursDebug.move({brake:true},2)");
      await action("interact");
      await until(
        "!window.afterhoursDebug.inspect().player.vehicle",
        `${kind} exit failed`,
      );
    }
    await page.evaluate("window.afterhoursDebug.teleport(-950,0)");
    // The swell is displaced on the GPU; a swimmer's authoritative height rides it.
    const swimHeight = () => page.evaluate("window.afterhoursDebug.inspect().player.y");
    const waterBefore = await swimHeight();
    await pause(500);
    assert.notEqual(
      waterBefore,
      await swimHeight(),
      "The swimmer did not ride the swell",
    );
    await transportCapture("water");
    const aiBefore = (
      await page.evaluate("window.afterhoursDebug.state()")
    ).entities.filter((e) => e.ai && ["boat", "jetski", "speedboat"].includes(e.kind));
    await pause(2000);
    const aiAfter = (await page.evaluate("window.afterhoursDebug.state()")).entities;
    assert.ok(
      aiBefore.some((e) =>
        aiAfter.some(
          (next) => next.id === e.id && Math.hypot(next.x - e.x, next.z - e.z) > 1,
        ),
      ),
      "AI watercraft did not cruise",
    );
  }
  const aircraft = process.argv.includes("--planes-only")
    ? ["plane", "aerobatic"]
    : ["scout", "utility", "plane", "aerobatic"];
  for (const model of aircraft) {
    // Spawn lookup comes from the actual authority, not a guessed screen target.
    const world = await page.evaluate("window.afterhoursDebug.state()");
    const craft = world.entities.find(
      (e) => e.model === model && !e.driver && !e.ai && !e.wreck,
    );
    assert.ok(craft, `${model} missing from normal map`);
    await page.evaluate(`window.afterhoursDebug.teleport(${craft.x + 4},${craft.z})`);
    await action("interact");
    await until(
      `window.afterhoursDebug.inspect().player.vehicle===${JSON.stringify(craft.id)}`,
      `${model} boarding failed`,
    );
    await until(
      "(()=>{const n=window.afterhoursDebug.network,p=n.entities.get(n.playerId),body=p?.vehicle?n.entities.get(p.vehicle):p;return !!body && n.worldReady(body)})()",
      `${model} collision chunks did not load`,
    );
    // Hold continuous controls through capture; an idle plane slows and stalls.
    const thrust = await page.evaluate(
      "(()=>{const d=window.afterhoursDebug;const hold=()=>void d.move({up:true,ascend:true},10);hold();return setInterval(hold,5000)})()",
    );
    try {
      await until(
        `window.afterhoursDebug.inspect().entities.some(e=>e.id===${JSON.stringify(craft.id)} && e.y>12)`,
        `${model} did not climb`,
      );
      if (craft.kind === "plane") await capture(model);
      else await transportCapture(model);
    } finally {
      await page.evaluate(`clearInterval(${thrust})`);
      await page.evaluate("window.afterhoursDebug.stop()");
    }
    await page.evaluate(
      "window.afterhoursDebug.move({up:true,right:true,descend:true},0.8)",
    );
    await action("interact");
    await until(
      "window.afterhoursDebug.inspect().player.parachute",
      `${model} airborne exit did not parachute`,
    );
    await until(
      "!window.afterhoursDebug.inspect().player.parachute",
      `${model} descent did not end`,
    );
  }
  assert.equal(
    page.logs.filter((line) => line.startsWith("exception")).length,
    0,
    page.logs.join("\n"),
  );
  await writeFile(
    resolve(output, "result.json"),
    JSON.stringify(
      {
        startedAt,
        completedAt: new Date().toISOString(),
        mode: process.argv.slice(2),
        viewport,
        state: await page.evaluate("window.afterhoursDebug.inspect()"),
        evidence,
        logs: page.logs,
      },
      null,
      2,
    ),
  );
  console.log(`Browser gameplay verified; captures in ${output}`);
} finally {
  buddy?.close();
  await page.close();
}
