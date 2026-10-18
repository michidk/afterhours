import { reuseCityEnv } from "../scripts/city-files.ts";
import { DEFAULT_CHARACTER } from "../shared/character.ts";
import { decodeSnapshot, applyPatch } from "../shared/codec.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import type { Entity } from "../shared/world.ts";
import { idle } from "../shared/world.ts";
import { VERSION, type Snapshot } from "../shared/protocol.ts";
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
test("multiplayer authority, delta recovery, input sequences, jitter, reconnects and abuse", async () => {
  let port = 0;
  const child = spawn(
      process.execPath,
      ["--import", "tsx", "server/index.ts", "--production"],
      {
        env: {
          ...process.env,
          ...reuseCityEnv(),
          PORT: String(port),
          ALLOW_DEBUG: "0",
        },
        stdio: "pipe",
      },
    ),
    sockets: WebSocket[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Startup timed out")), 60000);
      child.stdout.on("data", (d) => {
        const match = /AFTERHOURS http:\/\/localhost:(\d+)/.exec(String(d));
        if (match) {
          port = Number(match[1]);
          clearTimeout(timeout);
          resolve();
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code) reject(new Error("Server exited " + code));
      });
    });
    const connect = async (name: string, token?: string) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      sockets.push(ws);
      const messages: any[] = [],
        entities = new Map<string, Entity>();
      let last = 0;
      ws.on("message", (raw, binary) => {
        const m = binary ? decodeSnapshot(raw as Buffer) : JSON.parse(String(raw));
        messages.push(m);
        if (m.type === "state") {
          const s = m as Snapshot;
          assert.ok(s.full || s.base === last);
          if (s.full) entities.clear();
          for (const id of s.removed) entities.delete(id);
          for (const e of s.entities) applyPatch(entities, e);
          last = s.frame;
        }
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const send = (m: unknown) => ws.send(JSON.stringify(m));
      const wait = async (predicate: (m: any) => boolean) => {
        const end = Date.now() + 4000;
        while (Date.now() < end) {
          const found = messages.find(predicate);
          if (found) return found;
          await pause(15);
        }
        throw new Error("Network assertion timed out");
      };
      send({
        type: "join",
        version: VERSION,
        name,
        color: "#55a9b8",
        token,
        character: {
          ...DEFAULT_CHARACTER,
          physique: "tank",
          hair: "cap",
          legs: "cargo",
        },
      });
      return {
        ws,
        send,
        wait,
        messages,
        entities,
        welcome: await wait((m) => m.type === "welcome"),
      };
    };
    const a = await connect("Alice"),
      b = await connect("Bob");
    assert.equal(a.welcome.debug, false);
    assert.deepEqual(a.welcome.map, b.welcome.map);
    assert.equal(a.welcome.city, undefined);
    assert.deepEqual(
      await (await fetch(`http://localhost:${port}/city`)).json(),
      a.welcome.map,
    );
    const chunk = await fetch(
      `http://localhost:${port}/city/chunks/${a.welcome.map.mapId}/0/0`,
    );
    assert.equal(chunk.status, 200);
    assert.equal(chunk.headers.get("Cache-Control"), "no-store");
    assert.equal(((await chunk.json()) as any).key, "0,0");
    assert.equal(
      (await fetch(`http://localhost:${port}/city/chunks/${"0".repeat(64)}/0/0`))
        .status,
      409,
    );
    assert.equal(
      (
        await fetch(
          `http://localhost:${port}/city/chunks/${a.welcome.map.mapId}/999/999`,
        )
      ).status,
      404,
    );
    await b.wait((m) => m.type === "state" && m.players === 2);
    const roster = await b.wait((m) => m.type === "roster" && m.players.length === 2);
    assert.deepEqual(roster.players.map((p: any) => p.name).sort(), ["Alice", "Bob"]);
    assert.ok(roster.players.every((p: any) => p.color === "#55a9b8" && p.id));
    assert.ok(b.entities.has(a.welcome.id));
    await a.wait((m) => m.type === "state");
    const before = structuredClone(a.entities.get(a.welcome.id)!);
    assert.equal(before.maxHealth, 150);
    assert.deepEqual(before.character, {
      ...DEFAULT_CHARACTER,
      physique: "tank",
      hair: "cap",
      legs: "cargo",
    });
    assert.deepEqual(b.entities.get(a.welcome.id)!.character, before.character);
    a.send({ type: "input", x: 999999, z: 999999 });
    a.send({ type: "debug", kind: "pistol" });
    a.ws.send("{broken json");
    a.send({ type: "input", seq: 0, timestamp: 0, up: "yes" });
    await pause(120);
    a.send({ type: "chat", text: "Hello city" });
    assert.equal((await b.wait((m) => m.type === "chat")).text, "Hello city");
    assert.equal(a.entities.get(a.welcome.id)!.weapon, "fists");
    assert.ok(Math.abs(a.entities.get(a.welcome.id)!.x - before.x) < 3);
    for (let seq = 0; seq < 9; seq++) {
      a.send({ type: "input", seq, timestamp: Date.now(), ...idle(), up: true });
      await pause(seq % 3 === 0 ? 65 : 10);
      // A slow sender sees acks lead its commands: held slots are acknowledged in advance.
      await a.wait((m) => m.type === "state" && m.ack >= seq);
    }
    await a.wait((m) => m.type === "state" && m.ack >= 8);
    assert.ok(a.entities.get(a.welcome.id)!.z > before.z + 0.2);
    a.send({ type: "input", seq: 4, timestamp: 0, ...idle(), down: true });
    await pause(50);
    assert.ok(a.messages.filter((m) => m.type === "state").at(-1).ack >= 8);
    const heldFrame = a.messages.filter((m) => m.type === "state").at(-1).frame;
    await a.wait(
      (m) =>
        m.type === "state" &&
        m.frame > heldFrame &&
        Math.abs(a.entities.get(a.welcome.id)!.vz) < 0.1,
    );
    const stopped = a.entities.get(a.welcome.id)!;
    assert.ok(Math.abs(stopped.vz) < 0.1, "stale held input stops after 500 ms");
    const lastFrame = a.messages.filter((m) => m.type === "state").at(-1).frame;
    a.send({ type: "resync" });
    await a.wait((m) => m.type === "state" && m.full && m.frame > lastFrame);
    const id = a.welcome.id,
      token = a.welcome.token;
    a.ws.close();
    const left = await b.wait((m) => m.type === "roster" && m.players.length === 1);
    assert.equal(left.players[0].id, b.welcome.id);
    await pause(120);
    const restored = await connect("Alice", token);
    assert.equal(restored.welcome.id, id);
    await restored.wait((m) => m.type === "state" && m.ack === -1);
    const rejoined = await restored.wait(
      (m) => m.type === "roster" && m.players.length === 2,
    );
    assert.equal(new Set(rejoined.players.map((p: any) => p.id)).size, 2);
    restored.send({ type: "input", seq: 0, timestamp: 1, ...idle(), up: true });
    await restored.wait((m) => m.type === "state" && m.ack >= 0);
    const takeover = await connect("Alice", restored.welcome.token);
    assert.equal(
      takeover.welcome.id,
      id,
      "a reconnect can arrive before the old close event",
    );
    await takeover.wait((m) => m.type === "state" && m.players === 2);
    const health = (await (
      await fetch(`http://localhost:${port}/health`)
    ).json()) as any;
    assert.ok(health.rejectedMessages >= 3);
    assert.ok(Number.isFinite(health.tickP95Ms));
    assert.equal(health.players, 2);
    for (const scenario of [
      { origin: `http://127.0.0.1:${port}`, accepted: true },
      {
        origin: "https://city.example",
        forwardedHost: "city.example",
        accepted: true,
      },
      { origin: "https://malicious.example", accepted: false },
      {
        origin: "https://malicious.example",
        forwardedHost: "city.example",
        accepted: false,
      },
      {
        origin: `http://127.0.0.1:${port}`,
        forwardedHost: "city.example",
        accepted: false,
      },
      {
        origin: "https://city.example",
        forwardedHost: "city.example, malicious.example",
        accepted: false,
      },
      { origin: "null", accepted: false },
      {
        origin: "https://malicious.example",
        forwardedHost: "malicious.example",
        localAddress: "127.0.0.2",
        accepted: false,
      },
    ]) {
      const peer = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        origin: scenario.origin,
        localAddress: scenario.localAddress,
        headers: scenario.forwardedHost
          ? { "X-Forwarded-Host": scenario.forwardedHost }
          : undefined,
      });
      sockets.push(peer);
      const response = await new Promise<string | number>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Origin check timed out: ${scenario.origin}`)),
          4000,
        );
        peer.once("error", reject);
        peer.once("open", () => {
          peer.send(JSON.stringify({ type: "ping", timestamp: 123 }));
        });
        peer.once("message", (raw) => {
          clearTimeout(timeout);
          resolve(String(raw));
          peer.close();
        });
        peer.once("close", (code) => {
          clearTimeout(timeout);
          resolve(code);
        });
      });
      if (scenario.accepted) {
        assert.equal(typeof response, "string");
        assert.equal(JSON.parse(String(response)).type, "pong");
      } else assert.equal(response, 1008);
    }
  } finally {
    for (const ws of sockets) ws.terminate();
    child.kill();
  }
});
