import type { Character } from "../../shared/character.ts";
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
import { Prediction, interpolate } from "./prediction.ts";
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
  rtt: number | undefined;
  jitter = 0;
  ack = -1;
  ackTimestamp: number | undefined;
  snapshotInterval = 0;
  resyncs = 0;
  private welcomed = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private inputTimes: number[] = [];
  private snapshotTimes: number[] = [];
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
    private character?: Character,
  ) {}
  worldReady = (_point: { x: number; z: number }) => true;
  connect() {
    this.closed = false;
    this.welcomed = false;
    this.rtt = undefined;
    this.jitter = this.latency = this.received = this.snapshotInterval = 0;
    this.ack = -1;
    this.ackTimestamp = undefined;
    this.inputTimes = [];
    this.snapshotTimes = [];
    this.resyncs = 0;
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
        character: this.character,
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
        this.welcomed = true;
        clearInterval(this.heartbeat);
        const ping = () => this.send({ type: "ping", timestamp: performance.now() });
        ping();
        this.heartbeat = setInterval(ping, 1000);
        this.playerId = m.id;
        this.token = m.token;
        this.prediction = new Prediction(this.city ?? emptyCity(m.map), (point) =>
          this.worldReady(point),
        );
        this.seq = 0;
        this.frame = 0;
        this.entities.clear();
        this.timeline.reset();
        this.hooks.welcome(m);
        this.hooks.status("connected");
      }
      if (m.type === "state") {
        if (!this.welcomed) return;
        const snapshot = m as Snapshot;
        if (snapshot.version !== VERSION || snapshot.frame <= this.frame) return;
        if (!snapshot.full && snapshot.base !== this.frame) {
          this.resyncs++;
          this.send({ type: "resync" });
          return;
        }
        if (snapshot.full) this.entities.clear();
        for (const id of snapshot.removed) this.entities.delete(id);
        for (const e of snapshot.entities) applyPatch(this.entities, e);
        this.frame = snapshot.frame;
        this.serverTime = snapshot.time;
        const now = performance.now();
        this.snapshotInterval = this.received ? now - this.received : 0;
        this.received = now;
        this.snapshotTimes.push(now);
        this.snapshotTimes = this.snapshotTimes.filter((at) => at >= now - 1000);
        this.ack = snapshot.ack;
        this.ackTimestamp = snapshot.ackTimestamp;
        const entities = [...this.entities.values()];
        this.timeline.push(snapshot.time, entities, this.received);
        const p = this.entities.get(this.playerId);
        if (p) this.prediction?.reconcile(p, entities, snapshot.ack);
        this.hooks.state({ ...snapshot, entities });
      }
      if (m.type === "chat") this.hooks.chat(m.name, m.text);
      if (m.type === "roster") this.hooks.roster?.((m as PlayerRoster).players);
      if (m.type === "destruction") {
        if (this.city) setBrokenProps(this.city, m.brokenProps);
        this.hooks.destruction?.(m.brokenProps);
      }
      if (m.type === "pong" && Number.isFinite(m.timestamp)) {
        const rtt = Math.max(0, performance.now() - m.timestamp);
        this.jitter =
          this.rtt === undefined
            ? 0
            : this.jitter * 0.75 + Math.abs(rtt - this.rtt) * 0.25;
        this.rtt = rtt;
        this.latency = rtt / 2;
      }
    };
    this.socket.onclose = () => {
      this.welcomed = false;
      clearInterval(this.heartbeat);
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
  send(data: object) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ timestamp: performance.now(), ...data }));
  }
  input(input: Input) {
    if (
      this.socket?.readyState !== WebSocket.OPEN ||
      !this.welcomed ||
      !this.prediction
    )
      return;
    const timestamp = performance.now(),
      frame: InputFrame = {
        seq: this.seq++,
        timestamp,
        input: {
          ...input,
          shotTime: Math.max(
            0,
            this.serverTime + (timestamp - this.received) / 1000 - this.latency / 1000,
          ),
        },
      };
    this.send({ type: "input", seq: frame.seq, timestamp, ...frame.input });
    this.prediction.input(frame, [...this.entities.values()]);
    this.inputTimes.push(timestamp);
    this.inputTimes = this.inputTimes.filter((at) => at >= timestamp - 1000);
  }
  stats(now = performance.now()) {
    const p = this.prediction;
    return {
      connected: this.welcomed && this.socket?.readyState === WebSocket.OPEN,
      rtt: this.rtt,
      jitter: this.jitter,
      snapshotAge: this.received ? Math.max(0, now - this.received) : undefined,
      snapshotInterval: this.snapshotInterval,
      snapshotsPerSecond: this.snapshotTimes.filter((at) => at >= now - 1000).length,
      inputsPerSecond: this.inputTimes.filter((at) => at >= now - 1000).length,
      seq: this.seq - 1,
      ack: this.ack,
      ackAge:
        this.ackTimestamp === undefined
          ? undefined
          : Math.max(0, now - this.ackTimestamp),
      pending: p?.pending.length ?? 0,
      prediction: p?.status ?? "waiting for authority",
      correction: p?.lastCorrection.distance ?? 0,
      angle: ((p?.lastCorrection.angle ?? 0) * 180) / Math.PI,
      offset: p ? Math.hypot(p.offset.x, p.offset.z, p.offset.y) : 0,
      corrections: p?.corrections ?? 0,
      buffered: this.socket?.bufferedAmount ?? 0,
      resyncs: this.resyncs,
      serverTime: this.serverTime,
    };
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
    const prediction = this.prediction?.render(now);
    const controlled = currentPlayer?.vehicle
      ? this.entities.get(currentPlayer.vehicle)
      : currentPlayer;
    const predicted =
      prediction?.body ??
      (!currentPlayer?.vehicle || controlled?.driver === this.playerId
        ? controlled
        : undefined);
    if (predicted) {
      // Nearby contacts share the player's clock; distant traffic stays buffered.
      for (const neighbour of prediction?.neighbours ?? this.entities.values()) {
        if (neighbour.id === predicted.id || neighbour.vehicle) continue;
        const index = result.findIndex((e) => e.id === neighbour.id);
        const remote = index >= 0 ? result[index] : this.entities.get(neighbour.id);
        if (!remote) continue;
        const distance = Math.min(
          Math.hypot(remote.x - predicted.x, remote.z - predicted.z),
          Math.hypot(neighbour.x - predicted.x, neighbour.z - predicted.z),
        );
        const weight = Math.max(0, Math.min(1, (24 - distance) / 12));
        if (weight === 0) continue;
        const pose = interpolate(remote, neighbour, weight);
        if (index >= 0) result[index] = pose;
        else result.push(pose);
      }
      const index = result.findIndex((e) => e.id === predicted.id);
      if (index >= 0) result[index] = { ...predicted };
      else result.push({ ...predicted });
    }
    for (const p of result) {
      const v = p.vehicle && result.find((e) => e.id === p.vehicle);
      if (v) {
        p.x = v.x;
        p.z = v.z;
        p.y = v.y;
        p.angle = v.angle;
      }
    }
    return result;
  }
  close() {
    this.closed = true;
    this.welcomed = false;
    clearInterval(this.heartbeat);
    clearTimeout(this.retry);
    this.socket?.close();
  }
}
