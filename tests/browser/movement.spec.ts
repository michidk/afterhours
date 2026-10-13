import { test as base, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { MapManifest } from "../../shared/city-stream.ts";
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
  prediction?: {
    status: string;
    authorityReady: boolean;
    bodyReady: boolean;
    z: number | undefined;
    offset: number;
    correction: number;
  };
}
declare global {
  interface Window {
    afterhoursDebug?: AgentInterface;
    movementSamples: MovementSample[];
    movementStages: Record<
      | "prediction"
      | "reconcile"
      | "update"
      | "render"
      | "input"
      | "frame"
      | "beginFrame"
      | "endFrame",
      number[]
    >;
  }
}

const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    if (!process.env.BROWSER_CPU_PROFILE) {
      await use(page);
      return;
    }
    const session = await page.context().newCDPSession(page);
    await session.send("Profiler.enable");
    await session.send("Profiler.start");
    await session.send("Tracing.start", {
      categories: "devtools.timeline,v8,blink.user_timing,cc,gpu",
      transferMode: "ReturnAsStream",
    });
    try {
      await use(page);
    } finally {
      const { profile } = await session.send("Profiler.stop");
      const path = testInfo.outputPath("browser.cpuprofile");
      await writeFile(path, JSON.stringify(profile));
      await testInfo.attach("browser CPU profile", {
        path,
        contentType: "application/json",
      });
      const completed = new Promise<string>((resolve) =>
        session.once("Tracing.tracingComplete", (event) => resolve(event.stream!)),
      );
      await session.send("Tracing.end");
      const handle = await completed;
      let trace = "";
      while (true) {
        const chunk = await session.send("IO.read", { handle });
        trace += chunk.data;
        if (chunk.eof) break;
      }
      await session.send("IO.close", { handle });
      await writeFile(testInfo.outputPath("chrome-trace.json"), trace);
      await session.detach();
    }
  },
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
    // Startup has separate 30-second download and render-readiness deadlines.
    await expect(page.locator("#play")).toBeEnabled({
      timeout: Math.max(90_000, testInfo.timeout - 30_000),
    });
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
      window.movementStages = {
        prediction: [],
        reconcile: [],
        update: [],
        render: [],
        input: [],
        frame: [],
        beginFrame: [],
        endFrame: [],
      };
      let held = false;
      let frameStarted = 0;
      debug.scene.engine.onBeginFrameObservable.add(() => {
        frameStarted = performance.now();
      });
      debug.scene.engine.onEndFrameObservable.add(() => {
        if (held) window.movementStages.frame.push(performance.now() - frameStarted);
      });
      const measure =
        <A extends unknown[], R>(
          stage: keyof Window["movementStages"],
          run: (...args: A) => R,
        ) =>
        (...args: A): R => {
          const start = performance.now();
          try {
            return run(...args);
          } finally {
            if (held) window.movementStages[stage].push(performance.now() - start);
          }
        };
      debug.network.renderEntities = measure(
        "prediction",
        debug.network.renderEntities.bind(debug.network),
      );
      debug.network.input = measure("input", debug.network.input.bind(debug.network));
      const prediction = debug.network.prediction;
      if (prediction)
        prediction.reconcile = measure(
          "reconcile",
          prediction.reconcile.bind(prediction),
        );
      debug.scene.update = measure("update", debug.scene.update.bind(debug.scene));
      for (const stage of ["beginFrame", "endFrame"] as const)
        debug.scene.engine[stage] = measure(
          stage,
          debug.scene.engine[stage].bind(debug.scene.engine),
        );
      debug.scene.scene.render = measure(
        "render",
        debug.scene.scene.render.bind(debug.scene.scene),
      );
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
        performance.mark("movement-hold-start");
        held = true;
        window.movementSamples = [];
        sample("input");
      });
      window.addEventListener("keyup", (event) => {
        if (event.code !== "KeyW") return;
        sample("input");
        performance.mark("movement-hold-end");
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
    const stages = await page.evaluate(() => window.movementStages);
    const renderer = await page.evaluate(() => {
      const scene = window.afterhoursDebug?.scene.scene;
      return (
        scene && {
          browser: navigator.userAgent,
          hardwareConcurrency: navigator.hardwareConcurrency,
          graphics: window.afterhoursDebug!.scene.engine.getGlInfo(),
          hardwareScaling: scene.getEngine().getHardwareScalingLevel(),
          renderWidth: scene.getEngine().getRenderWidth(),
          renderHeight: scene.getEngine().getRenderHeight(),
          meshes: scene.meshes.length,
          candidates: scene.getActiveMeshCandidates().length,
          activeMeshes: scene.getActiveMeshes().length,
          vertices: scene.meshes.reduce(
            (sum, mesh) => sum + mesh.getTotalVertices(),
            0,
          ),
          materials: scene.materials.length,
        }
      );
    });
    const health = await (await request.get("http://127.0.0.1:4175/health")).json();
    const evidence = testInfo.outputPath("movement.json");
    await writeFile(
      evidence,
      JSON.stringify({ delay, samples, stages, renderer, health, errors }, null, 2),
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
      longestStall = Math.max(longestStall, rendered[i].wall - stalledAt);
      if (Math.abs(rendered[i].displayed - rendered[i - 1].displayed) > 0.001)
        stalledAt = rendered[i].wall;
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
      const upper = node
        ?.getChildTransformNodes(true)
        .find((n) => n.name === "upper body");
      const point = d?.scene.aimPoint(500, 300);
      if (!p || !node || !upper || !point || p.aim === undefined) return false;
      const target = Math.atan2(point.x - node.position.x, point.z - node.position.z);
      const difference = (a: number, b: number) =>
        Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
      return (
        difference(p.aim, target) < 0.15 &&
        difference(node.rotation.y + upper.rotation.y, target) < 0.15 &&
        difference(p.angle, 0) < 0.15 &&
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
      const upper = node
        ?.getChildTransformNodes(true)
        .find((n) => n.name === "upper body");
      const point = d?.scene.aimPoint(500, 300);
      if (!p || !node || !upper || !point || p.aim === undefined) return false;
      const target = Math.atan2(point.x - node.position.x, point.z - node.position.z);
      return (
        Math.abs(Math.atan2(Math.sin(p.aim - target), Math.cos(p.aim - target))) <
          0.15 &&
        Math.abs(p.angle + Math.PI / 2) < 0.15 &&
        Math.abs(node.rotation.y + Math.PI / 2) < 0.15 &&
        Math.abs(
          Math.atan2(
            Math.sin(node.rotation.y + upper.rotation.y - target),
            Math.cos(node.rotation.y + upper.rotation.y - target),
          ),
        ) < 0.15
      );
    });
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("walking.png") });
  });
}

test("nighttime scenery is ready far ahead and lamp pools stay lit when approached", async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#play")).toBeEnabled({ timeout: 90_000 });
  const startupChunks = await page.evaluate(
    () =>
      performance
        .getEntriesByType("resource")
        .filter((entry) => entry.name.includes("/city/chunks/")).length,
  );
  const manifest: MapManifest = await (await request.get("/city")).json();
  const origin = {
    x: (manifest.centre?.x ?? 0) + 11,
    z: (manifest.centre?.z ?? 0) + 25,
  };
  const span = (center: number) =>
    Math.floor(Math.min(manifest.limit, center + 512) / manifest.chunkSize) -
    Math.floor(Math.max(-manifest.limit, center - 512) / manifest.chunkSize) +
    1;
  expect(startupChunks).toBeGreaterThanOrEqual(span(origin.x) * span(origin.z));
  await page.locator("#name").fill("Scenery test");
  await page.locator("#play").click();
  await expect(page.locator("#entry")).toBeHidden();
  await page.waitForFunction(() => !!window.afterhoursDebug);
  const original = await page.evaluate(() => window.afterhoursDebug!.state());
  try {
    await page.evaluate(() => window.afterhoursDebug!.time(0));
    const distant = await page.evaluate(() => {
      const d = window.afterhoursDebug!;
      const pools = d.scene.scene.meshes.filter(
        (mesh) => mesh.name === "street light pool" && mesh.isEnabled(),
      );
      const pool = pools.find((mesh) => {
        const p = mesh.getAbsolutePosition();
        return Math.hypot(p.x - d.scene.target.x, p.z - d.scene.target.z) > 180;
      });
      if (!pool) throw Error("No distant lamp pool");
      const p = pool.getAbsolutePosition();
      return {
        poolCount: pools.length,
        lampCount: d.scene.lighting.lamps.length,
        alpha: pool.material!.alpha,
        x: p.x,
        z: p.z,
        parent: pool.parent!.name,
        distantBuildings: d.scene.city.buildings.filter(
          (b) =>
            Math.abs(b.x - d.scene.target.x) > 400 ||
            Math.abs(b.z - d.scene.target.z) > 400,
        ).length,
      };
    });
    expect(distant.poolCount).toBeGreaterThan(4);
    expect(distant.poolCount).toBe(distant.lampCount);
    expect(distant.alpha).toBeCloseTo(0.3);
    expect(distant.distantBuildings).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath("night-spawn.png") });
    await page.evaluate(async ({ x, z }) => {
      const d = window.afterhoursDebug!;
      d.camera("free", { x, y: 0, z });
      await d.settle();
    }, distant);
    const approached = await page.evaluate((parent) => {
      const pool = window.afterhoursDebug!.scene.scene.meshes.find(
        (mesh) => mesh.name === "street light pool" && mesh.parent?.name === parent,
      );
      return { enabled: pool?.isEnabled(), alpha: pool?.material?.alpha };
    }, distant.parent);
    expect(approached).toEqual({ enabled: true, alpha: distant.alpha });
    await page.screenshot({ path: testInfo.outputPath("night-distant-street.png") });
    await page.evaluate(() => window.afterhoursDebug!.time(12));
    expect(
      await page.evaluate(() =>
        window
          .afterhoursDebug!.scene.scene.meshes.filter(
            (mesh) => mesh.name === "street light pool",
          )
          .every((mesh) => mesh.material?.alpha === 0),
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(
      ({ day, dayRate }) => window.afterhoursDebug!.time(day, dayRate),
      original,
    );
  }
});

for (const model of ["sedan", "scout"] as const) {
  test(`${model} renders continuous held-key movement and stops`, async ({
    page,
    request,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(page.locator("#play")).toBeEnabled({ timeout: 90_000 });
    await page.locator("#name").fill(`${model} test`);
    await page.locator("#play").click();
    await expect(page.locator("#entry")).toBeHidden();
    await page.waitForFunction(
      () => !!window.afterhoursDebug?.network.prediction?.body,
    );
    const manifest: MapManifest = await (await request.get("/city")).json();
    const vehicleId = await page.evaluate(
      async ({ model, airport }) => {
        const d = window.afterhoursDebug!;
        d.scene.engine.setHardwareScalingLevel(2);
        await d.teleport(airport.x + 32, airport.z);
        const before = new Set((await d.state()).entities.map((e) => e.id));
        const state = await d.spawn(model);
        const vehicle = state.entities.find(
          (e) => e.model === model && !before.has(e.id),
        );
        if (!vehicle) throw Error("Vehicle was not spawned");
        await d.teleport(vehicle.x + 3, vehicle.z);
        return vehicle.id;
      },
      { model, airport: manifest.airport },
    );
    await page.keyboard.press("f");
    await page.waitForFunction((id) => {
      const d = window.afterhoursDebug!;
      return d.network.entities.get(d.network.playerId)?.vehicle === id;
    }, vehicleId);
    if (model === "scout") {
      await page.keyboard.down("Space");
      try {
        await page.waitForFunction(
          (id) =>
            window.afterhoursDebug!.network.entities.get(id)?.flight === "cruising",
          vehicleId,
        );
      } finally {
        await page.keyboard.up("Space");
      }
    }
    await page.evaluate(async (id) => {
      const d = window.afterhoursDebug!;
      await d.scene.scene.whenReadyAsync();
      await d.settle();
      window.movementSamples = [];
      let held = false;
      const sample = (kind: MovementSample["kind"]) => {
        if (!held) return;
        const body = d.network.entities.get(id);
        const node = d.scene.nodes.get(id);
        if (!body || !node) throw Error("Controlled vehicle missing");
        window.movementSamples.push({
          kind,
          wall: performance.now(),
          server: d.network.serverTime,
          frame: d.network.frame,
          seq: d.network.seq,
          authority: body.z,
          displayed: node.position.z,
          pending: d.network.prediction?.pending.length ?? 0,
          prediction: {
            status: d.network.prediction?.status ?? "missing",
            authorityReady: d.network.worldReady(body),
            bodyReady:
              !!d.network.prediction?.body &&
              d.network.worldReady(d.network.prediction.body),
            z: d.network.prediction?.body?.z,
            offset: d.network.prediction?.offset.z ?? 0,
            correction: d.network.prediction?.lastCorrection.distance ?? 0,
          },
        });
      };
      window.addEventListener("keydown", (event) => {
        if (event.code !== "KeyW" || event.repeat) return;
        held = true;
        sample("input");
      });
      window.addEventListener("keyup", (event) => {
        if (event.code !== "KeyW") return;
        sample("input");
        held = false;
      });
      d.scene.scene.onAfterRenderObservable.add(() => sample("render"));
    }, vehicleId);
    await page.keyboard.down("w");
    await page.waitForTimeout(3000);
    await page.keyboard.up("w");
    const samples = await page.evaluate(() => window.movementSamples);
    const path = testInfo.outputPath("vehicle-movement.json");
    await writeFile(path, JSON.stringify({ model, samples, errors }, null, 2));
    await testInfo.attach("vehicle movement", {
      path,
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
    expect(samples.length).toBeGreaterThan(2);
    expect(samples.at(-1)!.seq - samples[0].seq).toBeGreaterThan(30);
    expect(samples.at(-1)!.authority - samples[0].authority).toBeGreaterThan(8);
    expect(samples.at(-1)!.displayed - samples[0].displayed).toBeGreaterThan(8);
    const rendered = samples.filter((s) => s.kind === "render");
    expect(rendered.length).toBeGreaterThan(1);
    for (let i = 1; i < rendered.length; i++) {
      expect(
        rendered[i].wall - rendered[i - 1].wall,
        "rendered movement must not freeze",
      ).toBeLessThan(250);
      expect(
        rendered[i].displayed - rendered[i - 1].displayed,
        "vehicle must not rewind while accelerating",
      ).toBeGreaterThan(-0.01);
    }
    if (model === "sedan") await page.keyboard.down("Space");
    try {
      await page.waitForFunction((id) => {
        const d = window.afterhoursDebug!;
        const body = d.network.entities.get(id);
        const node = d.scene.nodes.get(id);
        return (
          body &&
          node &&
          Math.hypot(body.vx, body.vz) < 0.05 &&
          Math.hypot(body.x - node.position.x, body.z - node.position.z) < 0.15
        );
      }, vehicleId);
    } finally {
      await page.keyboard.up("Space");
    }
    expect(errors).toEqual([]);
  });
}
