import { VERSION } from "../../shared/version.ts";
import type {
  Snapshot,
  Welcome,
  InputFrame,
  PlayerRoster,
  PlayerSummary,
} from "../../shared/protocol.ts";
import type { Entity, Input, City } from "../../shared/world.ts";
import { decodeSnapshot, applyPatch } from "../../shared/codec.ts";
import { Prediction } from "./prediction.ts";
import { SnapshotTimeline } from "./timeline.ts";
import { emptyCity } from "../../shared/city-stream.ts";
import { setBrokenProps } from "../../shared/destruction.ts";
import type { DebugCommand, DebugResult, DebugState } from "../../shared/debug.ts";
export interface NetworkHooks {
  welcome: (m: Welcome) => void;
  state: (m: Omit<Snapshot, "entities"> & { entities: Entity[] }) => void;
  chat: (name: string, text: string) => void;
  status: (state: string) => void;
  roster?: (players: PlayerSummary[]) => void;
  destruction?: (brokenProps: string[]) => void;
}
export class GameNetwork {
  socket: WebSocket | undefined;
  entities = new Map<string, Entity>();
  prediction: Prediction | undefined;
  playerId = "";
  seq = 0;
  frame = 0;
  serverTime = 0;
  received = 0;
  latency = 0;
  token = "";
  private timeline = new SnapshotTimeline();
  private retry: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private debugSerial = 0;
  private debugRequests = new Map<
    number,
    {
      resolve: (state: DebugState) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private hooks: NetworkHooks,
    private name: string,
    private color: string,
    private city?: City,
  ) {}
  worldReady = () => true;
  connect() {
    this.closed = false;
    this.hooks.status("connecting");
    this.socket = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
    );
    this.socket.binaryType = "arraybuffer";
    this.socket.onopen = () =>
      this.send({
        type: "join",
        version: VERSION,
        name: this.name,
        color: this.color,
        token: this.token || undefined,
      });
    this.socket.onmessage = (event) => {
      let m;
      try {
        m =
          typeof event.data === "string"
            ? JSON.parse(event.data)
            : decodeSnapshot(event.data);
      } catch {
        return;
      }
      if (m.type === "debugResult") {
        const result = m as DebugResult,
          pending = this.debugRequests.get(result.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.debugRequests.delete(result.requestId);
          if (result.error || !result.state)
            pending.reject(Error(result.error || "Missing debug state"));
          else pending.resolve(result.state);
        }
        return;
      }
      if (m.type === "welcome") {
        if (m.version !== VERSION) {
          this.hooks.status("version mismatch");
          this.close();
          return;
        }
        this.playerId = m.id;
        this.token = m.token;
        this.prediction = new Prediction(this.city ?? emptyCity(m.map));
        this.seq = 0;
        this.frame = 0;
        this.entities.clear();
        this.timeline.reset();
        this.hooks.welcome(m);
        this.hooks.status("connected");
      }
      if (m.type === "state") {
        const snapshot = m as Snapshot;
        if (snapshot.version !== VERSION || snapshot.frame <= this.frame) return;
        if (!snapshot.full && snapshot.base !== this.frame) {
          this.send({ type: "resync" });
          return;
        }
        if (snapshot.full) this.entities.clear();
        for (const id of snapshot.removed) this.entities.delete(id);
        for (const e of snapshot.entities) applyPatch(this.entities, e);
        this.frame = snapshot.frame;
        this.serverTime = snapshot.time;
        this.received = performance.now();
        const entities = [...this.entities.values()];
        this.timeline.push(snapshot.time, entities, this.received);
        const p = this.entities.get(this.playerId);
        if (!this.worldReady() && this.prediction) this.prediction.pending.length = 0;
        if (p) this.prediction?.reconcile(p, entities, snapshot.ack);
        this.hooks.state({ ...snapshot, entities });
      }
      if (m.type === "chat") this.hooks.chat(m.name, m.text);
      if (m.type === "roster") this.hooks.roster?.((m as PlayerRoster).players);
      if (m.type === "destruction") {
        if (this.city) setBrokenProps(this.city, m.brokenProps);
        this.hooks.destruction?.(m.brokenProps);
      }
      if (m.type === "pong") this.latency = (performance.now() - m.timestamp) / 2;
    };
    this.socket.onclose = () => {
      for (const request of this.debugRequests.values()) {
        clearTimeout(request.timer);
        request.reject(Error("Connection closed"));
      }
      this.debugRequests.clear();
      this.prediction?.reset();
      if (this.closed) return;
      this.hooks.status("reconnecting");
      this.retry = setTimeout(() => this.connect(), 1500);
    };
    this.socket.onerror = () => this.hooks.status("connection error");
  }
  send(data: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(data));
  }
  input(input: Input) {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.prediction) return;
    const timestamp = performance.now(),
      frame: InputFrame = {
        seq: this.seq++,
        timestamp,
        input: {
          ...input,
          shotTime:
            this.serverTime + (timestamp - this.received) / 1000 - this.latency / 1000,
        },
      };
    this.send({ type: "input", seq: frame.seq, timestamp, ...frame.input });
    if (this.worldReady()) this.prediction.input(frame, [...this.entities.values()]);
    if (frame.seq % 60 === 0) this.send({ type: "ping", timestamp });
  }
  debug(command: DebugCommand): Promise<DebugState> {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(Error("Not connected"));
    const requestId = ++this.debugSerial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.debugRequests.delete(requestId);
        reject(Error("Debug request timed out"));
      }, 5000);
      this.debugRequests.set(requestId, { resolve, reject, timer });
      this.send({ type: "debugCommand", requestId, command });
    });
  }
  renderEntities(now = performance.now()) {
    const result = this.timeline.sample(now);
    const currentPlayer = this.entities.get(this.playerId);
    if (currentPlayer) {
      const i = result.findIndex((e) => e.id === this.playerId);
      if (i >= 0) result[i] = { ...currentPlayer };
      else result.push({ ...currentPlayer });
    }
    const predicted = this.worldReady() ? this.prediction?.render(now) : undefined;
    if (predicted) {
      const index = result.findIndex((e) => e.id === predicted.id);
      if (index >= 0) result[index] = { ...predicted };
      else result.push({ ...predicted });
    }
    const p = result.find((e) => e.id === this.playerId);
    const v = p?.vehicle && result.find((e) => e.id === p.vehicle);
    if (p && v) {
      p.x = v.x;
      p.z = v.z;
      p.y = v.y;
      p.angle = v.angle;
    }
    return result;
  }
  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.socket?.close();
  }
}
