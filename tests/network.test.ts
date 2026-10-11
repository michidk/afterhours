import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
test("two clients share authoritative state; forged positions and production cheats are ignored", async () => {
  const port = 19573,
    child = spawn(
      process.execPath,
      ["--import", "tsx", "server/index.ts", "--production"],
      {
        env: { ...process.env, PORT: String(port), ALLOW_DEBUG: "0" },
        stdio: "pipe",
      },
    );
  const sockets: WebSocket[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Server startup timed out")),
        10000,
      );
      child.stdout.on("data", (data) => {
        if (String(data).includes("AFTERHOURS")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code) reject(new Error(`Server exited ${code}`));
      });
    });
    const connect = async (name: string) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      sockets.push(ws);
      const messages: any[] = [];
      ws.on("message", (data) => messages.push(JSON.parse(String(data))));
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      ws.send(JSON.stringify({ type: "join", name, color: "#55a9b8" }));
      const wait = async (predicate: (m: any) => boolean) => {
        const end = Date.now() + 3000;
        while (Date.now() < end) {
          const found = messages.find(predicate);
          if (found) return found;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error("Network assertion timed out");
      };
      return {
        ws,
        messages,
        wait,
        welcome: await wait((m) => m.type === "welcome"),
      };
    };
    const a = await connect("Alice"),
      b = await connect("Bob");
    assert.equal(a.welcome.debug, false);
    assert.deepEqual(a.welcome.city, b.welcome.city);
    const state = await b.wait((m) => m.type === "state" && m.players === 2);
    assert.ok(state.entities.some((e: any) => e.id === a.welcome.id));
    const before = state.entities.find((e: any) => e.id === a.welcome.id);
    a.messages.length = 0;
    b.messages.length = 0;
    a.ws.send(JSON.stringify({ type: "input", x: 999999, z: 999999 }));
    a.ws.send(JSON.stringify({ type: "debug", kind: "pistol" }));
    a.ws.send("{broken json");
    a.ws.send(JSON.stringify({ type: "chat", text: "Hello city" }));
    const chat = await b.wait((m) => m.type === "chat");
    assert.equal(chat.name, "Alice");
    assert.equal(chat.text, "Hello city");
    const after = (await a.wait((m) => m.type === "state")).entities.find(
      (e: any) => e.id === a.welcome.id,
    );
    assert.ok(Math.abs(after.x - before.x) < 5);
    assert.equal(after.weapon, "fists");
    b.messages.length = 0;
    a.ws.send(JSON.stringify({ type: "input", up: true }));
    await new Promise((r) => setTimeout(r, 300));
    const latest = b.messages
      .filter((m) => m.type === "state")
      .at(-1)
      .entities.find((e: any) => e.id === a.welcome.id);
    assert.ok(latest.z > after.z);
    a.ws.close();
    await b.wait((m) => m.type === "state" && m.players === 1);
  } finally {
    for (const ws of sockets) ws.terminate();
    child.kill();
  }
});
