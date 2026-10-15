import { reuseCityEnv } from "./city-files.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import { GameNetwork } from "../client/network/index.ts";
import { OrderedDelay } from "./ordered-delay.ts";
import { InputClock } from "../client/input/clock.ts";
import { loadCity } from "../server/city-loader.ts";
import { CityStore } from "../server/city-stream.ts";
import { idle, spawnOrigin } from "../shared/world.ts";
import { TUNING } from "../shared/catalog.ts";
import { groundLevel, isWater } from "../shared/water.ts";

const city = await loadCity();
const mapId = new CityStore(city).manifest.mapId;
const origin = spawnOrigin(city);

async function until(check: () => boolean, description: string) {
  const deadline = performance.now() + 10000;
  while (!check()) {
    if (performance.now() > deadline) throw Error(`Timed out: ${description}`);
    await pause(10);
  }
}

const failures: Error[] = [];
for (const delay of [0, 150, 360]) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "server/index.ts", "--production"],
    {
      env: { ...process.env, ...reuseCityEnv(), PORT: "0", ALLOW_DEBUG: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const clients: GameNetwork[] = [];
  const delays: OrderedDelay[] = [];
  const intervals: ReturnType<typeof setInterval>[] = [];
  let serverOutput = "";
  child.stderr.on("data", (data) => {
    serverOutput = (serverOutput + String(data)).slice(-4000);
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Error(`Server startup timeout: ${serverOutput}`)),
        30000,
      );
      child.stdout.on("data", (data) => {
        serverOutput = (serverOutput + String(data)).slice(-4000);
        const match = /AFTERHOURS http:\/\/localhost:(\d+)/.exec(serverOutput);
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(Error(`Server exited ${code}: ${serverOutput}`));
      });
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { protocol: "http:", host: `127.0.0.1:${port}` },
    });
    for (const name of ["Walker", "Observer"]) {
      let receivedMap = "";
      const network = new GameNetwork(
        {
          welcome(message) {
            receivedMap = message.map.mapId;
          },
          state() {},
          chat() {},
          status() {},
        },
        name,
        "#55a9b8",
        structuredClone(city),
      );
      clients.push(network);
      network.connect();
      await until(() => !!network.prediction?.body, `${name} joins`);
      assert.equal(receivedMap, mapId, "prediction uses the server's saved city");
    }
    const [walker, observer] = clients;
    await observer.debug({ kind: "teleport", x: origin.x + 8, z: origin.z });
    await walker.debug({ kind: "teleport", x: origin.x, z: origin.z });
    await until(() => observer.entities.has(walker.playerId), "observer sees walker");
    for (const client of clients) {
      const socket = client.socket!;
      const send = socket.send.bind(socket),
        receive = socket.onmessage!;
      let outgoingAt = 0,
        incomingAt = 0,
        packet = 0;
      const outgoing = new OrderedDelay();
      const incoming = new OrderedDelay();
      delays.push(outgoing, incoming);
      socket.send = (data) => {
        outgoingAt = Math.max(
          outgoingAt,
          performance.now() + (delay ? 30 + (++packet % 3) * 10 : 0),
        );
        outgoing.schedule(outgoingAt, () => {
          if (socket.readyState === WebSocket.OPEN) send(data);
        });
      };
      socket.onmessage = (event) => {
        incomingAt = Math.max(
          incomingAt,
          performance.now() + delay + (delay ? (++packet % 3) * 10 : 0),
        );
        incoming.schedule(incomingAt, () => receive.call(socket, event));
      };
    }
    let held = false;
    let climbing = false;
    let driving = false;
    for (const [i, client] of clients.entries()) {
      const clock = new InputClock();
      // Like the browser, phase-lock the schedule to the reported server buffer.
      client.clock = clock;
      intervals.push(
        setInterval(
          () =>
            clock.advance(performance.now(), (timestamp) =>
              client.input(
                {
                  ...idle(),
                  up: i === 0 && held,
                  ascend: i === 0 && climbing,
                  brake: i === 0 && driving && !held,
                  aim: Math.PI / 2,
                },
                timestamp,
              ),
            ),
          5,
        ),
      );
    }
    async function measureRun(
      scenario: "walking" | "car" | "helicopter",
      bodyId: string,
    ) {
      await pause(750);
      const initial = walker.entities.get(bodyId)!;
      const initialZ = initial.z,
        initialSeq = walker.seq;
      const samples: {
        at: number;
        local: number;
        remote: number;
        authority: number;
        pending: number;
      }[] = [];
      let pendingPeak:
        { at: number; stats: ReturnType<GameNetwork["stats"]> } | undefined;
      const started = performance.now();
      const sampling = setInterval(() => {
        const now = performance.now();
        const local = walker.renderEntities(now).find((e) => e.id === bodyId);
        const remote = observer.renderEntities(now).find((e) => e.id === bodyId);
        const authority = walker.entities.get(bodyId);
        if (local && remote && authority) {
          samples.push({
            at: now - started,
            local: local.z,
            remote: remote.z,
            authority: authority.z,
            pending: walker.prediction?.pending.length ?? 0,
          });
          if (!pendingPeak || samples.at(-1)!.pending > pendingPeak.stats.pending)
            pendingPeak = { at: now - started, stats: walker.stats(now) };
        }
      }, 16);
      intervals.push(sampling);
      held = true;
      await pause(3000);
      held = false;
      const heldSeconds = (performance.now() - started) / 1000;
      const distance = walker.entities.get(bodyId)!.z - initialZ;
      const commands = walker.seq - initialSeq;
      await pause(scenario === "car" ? 15000 : 3000);
      clearInterval(sampling);
      const moving = samples.filter((s) => s.at >= 750 && s.at < 2800);
      const measure = (key: "local" | "remote") => {
        let movedAt = moving[0].at,
          freeze = 0,
          backward = 0,
          frameGap = 0;
        for (let i = 1; i < moving.length; i++) {
          const a = moving[i - 1],
            b = moving[i];
          frameGap = Math.max(frameGap, b.at - a.at);
          freeze = Math.max(freeze, b.at - movedAt);
          if (b[key] - a[key] > 0.001) movedAt = b.at;
          backward = Math.max(backward, a[key] - b[key]);
        }
        return { freeze, backward, frameGap };
      };
      assert.ok(moving.length > 30, "collect real-time rendered poses");
      const local = measure("local"),
        remote = measure("remote");
      const player = walker.entities.get(bodyId)!;
      const final = samples.at(-1)!;
      const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      console.log(
        JSON.stringify({
          scenario,
          delay,
          heldSeconds,
          distance,
          commands,
          samples: samples.length,
          local,
          remote,
          pending: Math.max(...samples.map((s) => s.pending)),
          pendingPeak,
          stopError: Math.abs(final.local - player.z),
          resyncs: clients.map((client) => client.resyncs),
          health,
        }),
      );
      assert.ok(commands >= 80, `held input cadence: ${commands}`);
      assert.ok(
        distance > 8 && distance / heldSeconds > 3,
        `authority ${scenario} speed: ${distance / heldSeconds}`,
      );
      for (const [name, metrics] of Object.entries({ local, remote })) {
        assert.ok(
          metrics.frameGap < 100,
          `${name} sample loop stalled: ${metrics.frameGap}`,
        );
        assert.ok(metrics.freeze < 250, `${name} pose froze: ${metrics.freeze}`);
        assert.ok(metrics.backward < 0.15, `${name} rewound: ${metrics.backward}`);
      }
      assert.ok(Math.abs(player.vz) < 0.05, "release reaches authority");
      if (scenario === "walking")
        assert.equal(player.aim, Math.PI / 2, "aim reaches authority");
      assert.ok(Math.abs(player.angle) < 0.05, "body faces the travel direction");
      assert.ok(Math.abs(final.local - player.z) < 0.05, "local stop converges");
      assert.ok(Math.abs(final.remote - player.z) < 0.05, "remote stop converges");
      assert.ok(
        Math.max(...samples.map((s) => s.pending)) <=
          Math.ceil(((delay + 70) * 30) / 1000) + 4 + TUNING.inputBuffer,
        "replay stays bounded by transit time and the buffered spares",
      );
      assert.ok(
        clients.every((client) => client.resyncs === 0),
        "no snapshot resyncs",
      );
    }
    await measureRun("walking", walker.playerId).catch((error: Error) => {
      failures.push(error);
      console.error(error);
    });
    for (const model of ["sedan", "scout"] as const) {
      driving = model === "sedan";
      // Stopping on a slope also measures gravity, so use the flat runway.
      const vehicleOrigin = driving
        ? { x: city.airport.x - 50, z: city.airport.z - 50 }
        : origin;
      if (driving) {
        const floor = groundLevel(vehicleOrigin.x, vehicleOrigin.z, city);
        for (let distance = 0; distance <= 140; distance += 5) {
          const z = vehicleOrigin.z + distance;
          assert.ok(!isWater(vehicleOrigin.x, z, city), "dry driving fixture");
          assert.ok(
            Math.abs(groundLevel(vehicleOrigin.x, z, city) - floor) < 0.01,
            "flat driving fixture",
          );
        }
      }
      await observer.debug({
        kind: "teleport",
        x: vehicleOrigin.x + 25,
        z: vehicleOrigin.z - 25,
      });
      await walker.debug({
        kind: "teleport",
        x: vehicleOrigin.x,
        z: vehicleOrigin.z,
      });
      await pause(150);
      const before = new Set(
        (await walker.debug({ kind: "state" })).entities.map((e) => e.id),
      );
      await pause(150);
      const spawned = await walker.debug({ kind: "spawn", model });
      const vehicle = spawned.entities.find(
        (e) => e.model === model && !before.has(e.id),
      );
      assert.ok(vehicle, `spawn ${model} in the saved city`);
      await pause(150);
      await walker.debug({ kind: "teleport", x: vehicle.x + 3, z: vehicle.z });
      walker.send({ type: "interact" });
      await until(
        () => walker.entities.get(walker.playerId)?.vehicle === vehicle.id,
        "driver boards",
      );
      if (model === "scout") {
        climbing = true;
        await until(
          () => walker.entities.get(vehicle.id)?.flight === "cruising",
          "helicopter takes off",
        );
        climbing = false;
      }
      await measureRun(driving ? "car" : "helicopter", vehicle.id).catch(
        (error: Error) => {
          failures.push(error);
          console.error(error);
        },
      );
      walker.send({ type: "interact" });
      await until(() => !walker.entities.get(walker.playerId)?.vehicle, "driver exits");
    }
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
    console.error(error);
  } finally {
    for (const delay of delays) delay.clear();
    for (const interval of intervals) clearInterval(interval);
    for (const client of clients) client.close();
    child.kill("SIGTERM");
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      clearTimeout(timeout);
    }
    Reflect.deleteProperty(globalThis, "location");
  }
}

if (failures.length)
  throw new AggregateError(failures, "Real-time movement checks failed");
