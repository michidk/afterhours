import { test as base, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { AgentInterface } from "../../client/debug/index.ts";

interface MovementSample {
  kind: "render" | "input";
  wall: number;
  server: number;
  frame: number;
  seq: number;
  authority: number;
  displayed: number;
  pending: number;
}
declare global {
  interface Window {
    afterhoursDebug?: AgentInterface;
    movementSamples: MovementSample[];
  }
}

const test = base.extend({
  browser: async ({ playwright }, use) => {
    const browser = process.env.CHROMIUM_CDP_URL
      ? await playwright.chromium.connectOverCDP(process.env.CHROMIUM_CDP_URL)
      : await playwright.chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
    try {
      await use(browser);
    } finally {
      await browser.close();
    }
  },
});

for (const delay of [0, 150]) {
  test(`held walking input stays continuous with ${delay} ms snapshot delay`, async ({
    page,
    request,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400)
        errors.push(`${response.status()} ${response.url()}`);
    });
    await page.goto("/");
    await expect(page.locator("#play")).toBeEnabled();
    await page.locator("#name").fill("Walking test");
    await page.locator("#name").press("Enter");
    await expect(page.locator("#entry")).toBeHidden();
    await page.waitForFunction(() => {
      const debug = window.afterhoursDebug;
      return (
        debug?.network.prediction?.body && debug.scene.nodes.has(debug.network.playerId)
      );
    });
    await page.evaluate(async (delay) => {
      const debug = window.afterhoursDebug;
      if (!debug) throw Error("Debug interface missing");
      const socket = debug.network.socket;
      const receive = socket?.onmessage;
      if (delay && socket && receive)
        socket.onmessage = (event) => {
          setTimeout(() => receive.call(socket, event), delay);
        };
      // Reduce only raster resolution for software WebGL; run the real update/render loop.
      debug.scene.engine.setHardwareScalingLevel(2);
      window.movementSamples = [];
      let held = false;
      const sample = (kind: MovementSample["kind"]) => {
        if (!held) return;
        const network = debug.network;
        const player = network.entities.get(network.playerId);
        const node = debug.scene.nodes.get(network.playerId);
        if (player && node)
          window.movementSamples.push({
            kind,
            wall: performance.now(),
            server: network.serverTime,
            frame: network.frame,
            seq: network.seq,
            authority: player.z,
            displayed: node.position.z,
            pending: network.prediction?.pending.length ?? 0,
          });
      };
      window.addEventListener("keydown", (event) => {
        if (event.code !== "KeyW" || event.repeat) return;
        held = true;
        window.movementSamples = [];
        sample("input");
      });
      window.addEventListener("keyup", (event) => {
        if (event.code !== "KeyW") return;
        sample("input");
        held = false;
      });
      debug.scene.scene.onAfterRenderObservable.add(() => sample("render"));
      await debug.scene.scene.whenReadyAsync();
      await debug.settle();
    }, delay);
    await page.keyboard.down("w");
    await page.waitForTimeout(3000);
    await page.keyboard.up("w");
    const samples = await page.evaluate(() => window.movementSamples);
    const health = await (await request.get("http://127.0.0.1:4175/health")).json();
    const evidence = testInfo.outputPath("movement.json");
    await writeFile(
      evidence,
      JSON.stringify({ delay, samples, health, errors }, null, 2),
    );
    await testInfo.attach("movement", {
      path: evidence,
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
    expect(samples.length, "sample multiple actual rendered positions").toBeGreaterThan(
      2,
    );
    const first = samples[0];
    const last = samples.at(-1)!;
    const seconds = (last.wall - first.wall) / 1000;
    expect(
      last.seq - first.seq,
      "holding one key must send repeated inputs",
    ).toBeGreaterThan(30);
    expect(
      last.authority - first.authority,
      "authority must walk at game speed",
    ).toBeGreaterThan(8);
    expect(
      (last.authority - first.authority) / seconds,
      "walking must sustain at least two thirds of its 4.5 m/s speed",
    ).toBeGreaterThan(3);
    expect(
      last.displayed - first.displayed,
      "the renderer must show walking",
    ).toBeGreaterThan(8);
    const rendered = samples.filter((sample) => sample.kind === "render");
    expect(rendered.length, "sample multiple actual rendered frames").toBeGreaterThan(
      1,
    );
    let stalledAt = rendered[0].wall;
    let longestStall = 0;
    for (let i = 1; i < rendered.length; i++) {
      if (Math.abs(rendered[i].displayed - rendered[i - 1].displayed) > 0.001)
        stalledAt = rendered[i].wall;
      longestStall = Math.max(longestStall, rendered[i].wall - stalledAt);
    }
    expect(
      longestStall,
      "held movement must not freeze between snapshots",
    ).toBeLessThan(250);
    await page.waitForTimeout(1000);
    const stopped = await page.evaluate(() => {
      const debug = window.afterhoursDebug;
      const p = debug?.network.entities.get(debug.network.playerId);
      return p && { speed: Math.hypot(p.vx, p.vz), z: p.z };
    });
    expect(stopped?.speed).toBeLessThan(0.05);
    await page.keyboard.press("F1");
    await expect(page.locator("#debug")).toBeVisible();
    await expect(page.locator("#network-stats")).toContainText("Server ping (RTT)");
    await expect(
      page
        .locator("#network-stats dt", { hasText: "Server ping (RTT)" })
        .locator("+ dd"),
    ).toHaveText(/\d+ ms/);
    await expect(
      page
        .locator("#network-stats dt", { hasText: "Sent / applied input" })
        .locator("+ dd"),
    ).toHaveText(/\d+ \/ \d+/);
    await page.screenshot({ path: testInfo.outputPath("networking.png") });
    await page.keyboard.press("Escape");
    await expect(page.locator("#debug")).toBeHidden();
    await page.mouse.move(500, 300);
    await page.waitForFunction(() => {
      const d = window.afterhoursDebug;
      const p = d?.network.entities.get(d.network.playerId);
      const node = p && d?.scene.nodes.get(p.id);
      const point = d?.scene.aimPoint(500, 300);
      if (!p || !node || !point) return false;
      const target = Math.atan2(point.x - node.position.x, point.z - node.position.z);
      const difference = (a: number, b: number) =>
        Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
      return (
        difference(p.angle, target) < 0.15 &&
        difference(node.rotation.y, p.angle) < 0.15
      );
    });
    await page.keyboard.down("a");
    await page.waitForTimeout(1000);
    await page.keyboard.up("a");
    await page.waitForFunction(() => {
      const d = window.afterhoursDebug;
      const p = d?.network.entities.get(d.network.playerId);
      const node = p && d?.scene.nodes.get(p.id);
      const point = d?.scene.aimPoint(500, 300);
      if (!p || !node || !point) return false;
      const target = Math.atan2(point.x - node.position.x, point.z - node.position.z);
      return (
        Math.abs(Math.atan2(Math.sin(p.angle - target), Math.cos(p.angle - target))) <
        0.15
      );
    });
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("walking.png") });
  });
}
