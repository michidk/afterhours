import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import { GameNetwork } from "../client/network/index.ts";
import { InputClock } from "../client/input/clock.ts";
import { loadCity } from "../server/city-loader.ts";
import { CityStore } from "../server/city-stream.ts";
import { idle, spawnOrigin } from "../shared/world.ts";

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
      env: { ...process.env, PORT: "0", ALLOW_DEBUG: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const clients: GameNetwork[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
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
      const schedule = (at: number, deliver: () => void) => {
        const timer = setTimeout(
          () => {
            timers.delete(timer);
            deliver();
          },
          Math.max(0, at - performance.now()),
        );
        timers.add(timer);
      };
      socket.send = (data) => {
        outgoingAt = Math.max(
          outgoingAt,
          performance.now() + (delay ? 30 + (++packet % 3) * 10 : 0),
        );
        schedule(outgoingAt, () => {
          if (socket.readyState === WebSocket.OPEN) send(data);
        });
      };
      socket.onmessage = (event) => {
        incomingAt = Math.max(
          incomingAt,
          performance.now() + delay + (delay ? (++packet % 3) * 10 : 0),
        );
        schedule(incomingAt, () => receive.call(socket, event));
      };
    }
    let held = false;
    let climbing = false;
    for (const [i, client] of clients.entries()) {
      const clock = new InputClock();
      intervals.push(
        setInterval(
          () =>
            clock.advance(performance.now(), (timestamp) =>
              client.input(
                {
                  ...idle(),
                  up: i === 0 && held,
                  ascend: i === 0 && climbing,
                  aim: Math.PI / 2,
                },
                timestamp,
              ),
            ),
          5,
        ),
      );
    }
    async function measureRun(scenario: "walking" | "helicopter", bodyId: string) {
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
      const started = performance.now();
      const sampling = setInterval(() => {
        const now = performance.now();
        const local = walker.renderEntities(now).find((e) => e.id === bodyId);
        const remote = observer.renderEntities(now).find((e) => e.id === bodyId);
        const authority = walker.entities.get(bodyId);
        if (local && remote && authority)
          samples.push({
            at: now - started,
            local: local.z,
            remote: remote.z,
            authority: authority.z,
            pending: walker.prediction?.pending.length ?? 0,
          });
      }, 16);
      intervals.push(sampling);
      held = true;
      await pause(3000);
      held = false;
      const heldSeconds = (performance.now() - started) / 1000;
      const distance = walker.entities.get(bodyId)!.z - initialZ;
      const commands = walker.seq - initialSeq;
      await pause(3000);
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
          stopError: Math.abs(final.local - player.z),
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
          Math.ceil(((delay + 70) * 30) / 1000) + 4,
        "replay stays bounded by transit time",
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
    await observer.debug({
      kind: "teleport",
      x: city.airport.x + 50,
      z: city.airport.z,
    });
    await walker.debug({ kind: "teleport", x: city.airport.x + 32, z: city.airport.z });
    await pause(150);
    const before = new Set(
      (await walker.debug({ kind: "state" })).entities.map((e) => e.id),
    );
    await pause(150);
    const spawned = await walker.debug({ kind: "spawn", model: "scout" });
    const helicopter = spawned.entities.find(
      (e) => e.model === "scout" && !before.has(e.id),
    );
    assert.ok(helicopter, "spawn a helicopter in the airfield");
    await pause(150);
    await walker.debug({ kind: "teleport", x: helicopter.x + 3, z: helicopter.z });
    walker.send({ type: "interact" });
    await until(
      () => walker.entities.get(walker.playerId)?.vehicle === helicopter.id,
      "pilot boards",
    );
    climbing = true;
    await until(
      () => walker.entities.get(helicopter.id)?.flight === "cruising",
      "helicopter takes off",
    );
    climbing = false;
    await measureRun("helicopter", helicopter.id);
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
    console.error(error);
  } finally {
    for (const timer of timers) clearTimeout(timer);
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
