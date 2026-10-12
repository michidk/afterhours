import { WebSocket } from "ws";
import { decodeSnapshot, applyPatch } from "../shared/codec.ts";
import { VERSION, type Welcome } from "../shared/protocol.ts";
import type { DebugCommand, DebugResult, DebugState } from "../shared/debug.ts";
import { idle, type Entity, type Input } from "../shared/world.ts";

export const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export class AgentClient {
  entities = new Map<string, Entity>();
  welcome!: Welcome;
  private serial = 0;
  private seq = 0;
  private lastCommand = 0;
  private commandQueue = Promise.resolve();
  private requests = new Map<
    number,
    {
      resolve: (state: DebugState) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private constructor(readonly socket: WebSocket) {}
  static async connect(url = "http://localhost:5174", name = "Agent test") {
    const endpoint = new URL("/ws", url);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(endpoint);
    const client = new AgentClient(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Join timed out")), 5000);
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.on("open", () =>
        socket.send(
          JSON.stringify({
            type: "join",
            timestamp: performance.now(),
            version: VERSION,
            name,
            color: "#55a9b8",
          }),
        ),
      );
      socket.on("message", (raw, binary) => {
        const message = binary
          ? decodeSnapshot(raw as Buffer)
          : JSON.parse(String(raw));
        if (message.type === "welcome") {
          clearTimeout(timer);
          client.welcome = message;
          client.heartbeat = setInterval(
            () => client.send({ type: "ping", timestamp: performance.now() }),
            1000,
          );
          resolve();
        }
        if (message.type === "state") {
          if (message.full) client.entities.clear();
          for (const id of message.removed) client.entities.delete(id);
          for (const patch of message.entities) applyPatch(client.entities, patch);
        }
        if (message.type === "debugResult") client.result(message);
      });
    });
    socket.on("close", () => {
      clearInterval(client.heartbeat);
      for (const pending of client.requests.values()) {
        clearTimeout(pending.timer);
        pending.reject(Error("Connection closed"));
      }
      client.requests.clear();
    });
    return client;
  }
  send(message: object) {
    this.socket.send(JSON.stringify({ timestamp: performance.now(), ...message }));
  }
  async command(command: DebugCommand): Promise<DebugState> {
    const result = this.commandQueue.then(() => this.executeCommand(command));
    this.commandQueue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async executeCommand(command: DebugCommand): Promise<DebugState> {
    await pause(Math.max(0, 125 - (Date.now() - this.lastCommand)));
    const requestId = ++this.serial;
    try {
      return await new Promise<DebugState>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.requests.delete(requestId);
          reject(Error("Debug request timed out"));
        }, 5000);
        this.requests.set(requestId, { resolve, reject, timer });
        this.send({ type: "debugCommand", requestId, command });
      });
    } finally {
      this.lastCommand = Date.now();
    }
  }
  async move(input: Partial<Input>, seconds: number) {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 10)
      throw Error("Movement duration must be 0–10 seconds");
    const end = performance.now() + seconds * 1000;
    while (performance.now() < end) {
      this.send({
        type: "input",
        seq: this.seq++,
        timestamp: performance.now(),
        ...idle(),
        ...input,
      });
      await pause(1000 / 30);
    }
    this.send({
      type: "input",
      seq: this.seq++,
      timestamp: performance.now(),
      ...idle(),
    });
  }
  close() {
    clearInterval(this.heartbeat);
    this.socket.close();
  }
  private result(result: DebugResult) {
    const pending = this.requests.get(result.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.requests.delete(result.requestId);
    if (result.error || !result.state)
      pending.reject(Error(result.error || "Missing state"));
    else pending.resolve(result.state);
  }
}
