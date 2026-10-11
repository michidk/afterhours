import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Simulation } from "../server/simulation.ts";
import { executeDebug, debugState } from "../server/debug.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { AgentClient, pause } from "../scripts/agent-client.ts";
import { debugCommandSchema } from "../shared/debug.ts";
import { idle } from "../shared/world.ts";
import { DebugCamera } from "../client/camera/debug.ts";
import { environmentAt } from "../client/lighting/environment.ts";

test("authoritative debug time freezes, advances, and wraps a complete day", () => {
  const sim = new Simulation(generateCity());
  sim.entities.clear();
  const player = sim.join("Test", "#fff");
  executeDebug(sim, player, { kind: "time", hour: 6.5, rate: 0 });
  sim.tick(1 / 30);
  assert.equal(sim.day, 6.5);
  executeDebug(sim, player, { kind: "time", hour: 23, rate: 2 });
  for (let i = 0; i < 60; i++) sim.tick(1 / 30);
  assert.ok(Math.abs(sim.day - 3) < 1e-9);
  const state = debugState(sim, player);
  state.entities[0].health = -999;
  assert.equal(player.health, 100, "debug inspection does not leak mutable state");
  assert.equal(debugCommandSchema.safeParse({ kind: "time", hour: -1 }).success, false);
  assert.equal(
    debugCommandSchema.safeParse({ kind: "time", hour: 12, rate: Infinity }).success,
    false,
  );
  const building = sim.city.buildings[0];
  assert.throws(
    () => executeDebug(sim, player, { kind: "teleport", x: building.x, z: building.z }),
    /obstructed/,
  );
});

test("camera movement and look stay independent while zoom has no gameplay limits", () => {
  const camera = new DebugCamera();
  const player = { x: 11, y: 0, z: 25 };
  camera.setMode("free", { x: 11, y: 46, z: -1 }, player);
  const accessorPosition = Object.create({ x: 11, y: 46, z: -1 });
  const accessorFocus = Object.create({ x: 11, y: 0, z: 25 });
  camera.setMode("free", accessorPosition, accessorFocus);
  assert.ok(
    [camera.position.x, camera.position.y, camera.position.z].every(Number.isFinite),
  );
  const distance = camera.distance;
  camera.update({ ...idle(), up: true, right: true }, 1);
  assert.ok(camera.focus.x > 11 && camera.focus.z > 25);
  assert.equal(Math.hypot(camera.focus.x - 11, camera.focus.z - 25), 25);
  assert.deepEqual(player, { x: 11, y: 0, z: 25 });
  camera.zoom(-200);
  assert.ok(camera.distance < distance);
  camera.zoom(2000);
  assert.ok(camera.distance > 180);
  camera.zoom(-6000);
  assert.ok(camera.distance < 12 && camera.distance > 0);
  camera.setMode("fly", { x: 0, y: 20, z: 0 }, { x: 0, y: 20, z: 1 });
  camera.setPose(Object.create({ x: 0, y: 20, z: 0 }));
  assert.equal(camera.position.x, 0);
  assert.equal(camera.position.z, 0);
  const initialFov = camera.fov;
  camera.zoom(6000);
  assert.ok(camera.fov > 1.2 && camera.fov < Math.PI);
  camera.zoom(-12000);
  assert.ok(camera.fov < 0.3 && camera.fov > 0);
  camera.zoom(6000);
  assert.ok(Math.abs(camera.fov - initialFov) < 1e-12);
  camera.zoom(1e8);
  assert.ok(camera.fov < Math.PI);
  camera.zoom(-1e8);
  assert.ok(Math.abs(camera.fov - initialFov) < 1e-12);
  camera.look(100, -100);
  const start = { ...camera.position };
  camera.update({ ...idle(), up: true }, 1);
  assert.ok(camera.position.x > start.x && camera.position.y > start.y);
  camera.look(0, 1e8);
  assert.equal(camera.pitch, -1.45);
  camera.setMode("follow", camera.position, player);
  const before = { ...camera.position };
  camera.update({ ...idle(), up: true }, 1);
  assert.deepEqual(camera.position, before);
});

test("debug cameras reach offshore water and stay inside the shared world boundary", () => {
  const camera = new DebugCamera();
  camera.setMode("free", { x: 0, y: 46, z: -26 }, { x: 0, y: 0, z: 0 });
  camera.setPose({ x: -950, y: 0, z: 0 });
  assert.equal(camera.focus.x, -950);
  camera.update({ ...idle(), left: true }, 10);
  assert.equal(camera.focus.x, -1068);
});

test("lighting is continuous, periodic and readable across the full day", () => {
  for (let hour = 0; hour < 24; hour += 0.01) {
    const a = environmentAt(hour),
      b = environmentAt(hour + 0.001);
    for (const key of [
      "daylight",
      "night",
      "windowGlow",
      "lampIntensity",
      "ambientIntensity",
    ] as const)
      assert.ok(Math.abs(a[key] - b[key]) < 0.005, `${key} at ${hour}`);
    assert.ok(
      Math.abs(a.directIntensity - b.directIntensity) < 0.04,
      `direct light at ${hour}`,
    );
    assert.ok(a.ambientIntensity >= 0.46);
    assert.ok(a.lightDirection[1] >= 0);
  }
  assert.deepEqual(environmentAt(0), environmentAt(24));
  assert.equal(environmentAt(12).windowGlow, 0);
  assert.equal(environmentAt(12).lampIntensity, 0);
  assert.ok(environmentAt(0).windowGlow > 0.8);
  assert.ok(environmentAt(0).lampIntensity > 1);
  assert.ok(environmentAt(6).twilight > 0.9);
  assert.ok(environmentAt(18).twilight > 0.9);
  assert.notDeepEqual(environmentAt(9).sunDirection, environmentAt(15).sunDirection);
});

test("script debug interface controls real transport and production rejects it", async () => {
  for (const enabled of [false, true]) {
    let port = 0;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "server/index.ts", "--production"],
      {
        env: { ...process.env, PORT: String(port), ALLOW_DEBUG: enabled ? "1" : "0" },
        stdio: "pipe",
      },
    );
    let client: AgentClient | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("Server startup timed out")),
          10000,
        );
        child.stdout.on("data", (data) => {
          const match = /AFTERHOURS http:\/\/localhost:(\d+)/.exec(String(data));
          if (match) {
            port = Number(match[1]);
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("error", reject);
      });
      client = await AgentClient.connect(`http://localhost:${port}`);
      assert.equal(client.welcome.debug, enabled);
      if (!enabled) {
        await assert.rejects(
          client.command({ kind: "time", hour: 0, rate: 0 }),
          /disabled/,
        );
        client.send({ type: "debugView", center: { x: -190, z: -190 } });
        await pause(150);
        assert.ok(client.entities.has(client.welcome.id));
      } else {
        const state = await client.command({ kind: "time", hour: 6.5, rate: 0 });
        assert.equal(state.day, 6.5);
        await pause(200);
        assert.equal((await client.command({ kind: "state" })).day, 6.5);
        const before = state.entities.find((e) => e.id === client!.welcome.id)!;
        await client.move({ up: true }, 0.4);
        const after = await client.command({ kind: "state" });
        assert.ok(after.entities.find((e) => e.id === before.id)!.z > before.z + 0.3);
        const spawned = await client.command({ kind: "spawn", model: "sport" });
        assert.equal(spawned.entities.length, after.entities.length + 1);
        assert.ok(spawned.entities.some((e) => e.model === "sport" && !e.ai));
        client.send({ type: "debugView", center: { x: -190, z: -190 } });
        const deadline = Date.now() + 5000;
        while (
          ![...client.entities.values()].some(
            (e) => e.kind !== "player" && Math.hypot(e.x + 190, e.z + 190) < 110,
          ) &&
          Date.now() < deadline
        )
          await pause(20);
        assert.ok(client.entities.has(client.welcome.id));
        assert.ok(
          [...client.entities.values()].some(
            (e) => e.kind !== "player" && Math.hypot(e.x + 190, e.z + 190) < 110,
          ),
        );
      }
    } finally {
      client?.close();
      child.kill();
    }
  }
});
