import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { GameNetwork } from "../client/network/index.ts";
import { InputClock } from "../client/input/clock.ts";
import { Simulation } from "../server/simulation.ts";
import { Sessions } from "../server/session.ts";
import { CityStore } from "../server/city-stream.ts";
import { generateCity } from "../scripts/city-generator.ts";
import { idle } from "../shared/world.ts";

// Real sockets, codecs and physics; virtual scheduling isolates transport from CPU load.
for (const distance of [8, 80])
  for (const wakeup of [33, 50, 80]) {
    test(`bidirectional jitter preserves held movement with ${wakeup} ms client wakeups and a neighbour at ${distance} m`, async (t) => {
      const city = generateCity();
      city.props = [];
      city.buildings = [];
      const sim = new Simulation(city);
      sim.entities.clear();
      const server = createServer();
      const sessions = new Sessions(server, sim, false, new CityStore(city).manifest);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const location = Object.getOwnPropertyDescriptor(globalThis, "location");
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: { protocol: "http:", host: `127.0.0.1:${address.port}` },
      });
      let ready!: () => void;
      const welcome = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let state: (() => void) | undefined;
      const network = new GameNetwork(
        { welcome: ready, state: () => state?.(), chat() {}, status() {} },
        "Cadence",
        "#ffffff",
        city,
      );
      let now = 0;
      const epoch = Date.now();
      t.mock.method(performance, "now", () => now);
      t.mock.method(Date, "now", () => epoch + now);
      try {
        network.connect();
        await welcome;
        const player = sim.entities.get(network.playerId)!;
        player.x = player.z = 0;
        const remote = sim.join("Remote", "#ffffff");
        remote.x = distance;
        remote.z = 0;
        sim.tick(1 / 30);
        await new Promise<void>((resolve) => {
          state = resolve;
          sessions.broadcast();
        });
        const socket = network.socket!;
        const peer = [...sessions.clients.keys()][0];
        const send = socket.send.bind(socket);
        const receive = socket.onmessage!;
        const outgoing: { at: number; data: Parameters<typeof socket.send>[0] }[] = [];
        const incoming: { at: number; event: MessageEvent }[] = [];
        socket.send = (data) =>
          outgoing.push({
            at: Math.max(
              outgoing.at(-1)?.at ?? 0,
              now + 30 + (Math.floor(now / 67) % 3) * 15,
            ),
            data,
          });
        let arrived: (() => void) | undefined;
        socket.onmessage = (event) => {
          incoming.push({
            at: Math.max(
              incoming.at(-1)?.at ?? 0,
              now + 40 + (Math.floor(now / 71) % 3) * 15,
            ),
            event,
          });
          if (event.data instanceof ArrayBuffer) arrived?.();
        };
        const clock = new InputClock();
        let tick = 0;
        let previous = 0;
        let backward = 0;
        let maxError = 0;
        let displayedAtStop = 0;
        let remotePrevious = 0;
        let remoteBackward = 0;
        let remoteAtStop = 0;
        let movedAt = 1000;
        let freeze = 0;
        for (now = 0; now <= 4500; now++) {
          if (now % wakeup === 0)
            clock.advance(now, (timestamp) =>
              network.input({ ...idle(), up: now < 3000, aim: Math.PI / 2 }, timestamp),
            );
          while (outgoing[0]?.at <= now) {
            const delivered = once(peer, "message");
            send(outgoing.shift()!.data);
            await delivered;
          }
          if (now + 1e-6 >= (tick * 1000) / 30) {
            sim.inputs.set(remote.id, { ...idle(), up: now < 3000 });
            sessions.tick();
            sim.tick(1 / 30);
            if (tick % 2 === 0) {
              await new Promise<void>((resolve) => {
                arrived = resolve;
                sessions.broadcast();
              });
              arrived = undefined;
            }
            tick++;
          }
          while (incoming[0]?.at <= now) receive.call(socket, incoming.shift()!.event);
          if (now % 16 === 0) {
            const rendered = network.renderEntities(now);
            const pose = rendered.find((e) => e.id === player.id)!;
            const other = rendered.find((e) => e.id === remote.id)!;
            remoteBackward = Math.max(remoteBackward, remotePrevious - other.z);
            remotePrevious = other.z;
            if (now < 3000) remoteAtStop = other.z;
            if (now >= 1000 && now < 2800) {
              freeze = Math.max(freeze, now - movedAt);
              if (pose.z - previous > 0.001) movedAt = now;
            }
            backward = Math.max(backward, previous - pose.z);
            maxError = Math.max(maxError, Math.abs(pose.z - player.z));
            previous = pose.z;
            if (now < 3000) displayedAtStop = pose.z;
          }
        }
        assert.ok(
          network.seq >= 134,
          "client simulates 30 input ticks per second despite delayed wakeups",
        );
        assert.ok(player.z > 11, `authority travels at walking speed: ${player.z}`);
        assert.ok(
          displayedAtStop > 10,
          `display progresses while held: ${displayedAtStop}`,
        );
        assert.ok(backward < 0.15, `no visible backward corrections: ${backward}`);
        assert.ok(maxError < 1.5, `prediction remains near authority: ${maxError}`);
        assert.ok(Math.abs(previous - player.z) < 0.03, "stop converges to authority");
        assert.ok(freeze <= 100, `no frozen local pose between snapshots: ${freeze}`);
        assert.ok(
          remoteAtStop > 10,
          `remote interpolation progresses: ${remoteAtStop}`,
        );
        assert.ok(
          remoteBackward < 0.01,
          `remote interpolation never reverses: ${remoteBackward}`,
        );
        assert.ok(Math.abs(remotePrevious - remote.z) < 0.03, "remote stop settles");
        assert.equal(player.vz, 0);
        assert.equal(player.aim, Math.PI / 2);
        assert.equal(sessions.rejected, 0);
        assert.ok(network.prediction!.pending.length < 8);
      } finally {
        network.close();
        sessions.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        sim.destruction.dispose();
        if (location) Object.defineProperty(globalThis, "location", location);
        else Reflect.deleteProperty(globalThis, "location");
      }
    });
  }
