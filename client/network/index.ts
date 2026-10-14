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
import type { InputClock } from "../input/clock.ts";
import { emptyCity } from "../../shared/city-stream.ts";
import { setBrokenProps } from "../../shared/destruction.ts";
import type { DebugCommand, DebugResult, DebugState } from "../../shared/debug.ts";
import { wrap } from "../../shared/physics/vehicle.ts";
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
  /** Commands the server still had buffered after its last tick. */
  queued: number | undefined;
  /** When attached, snapshot buffer reports phase-lock the 30 Hz command schedule. */
  clock: InputClock | undefined;
  snapshotInterval = 0;
  resyncs = 0;
  private welcomed = false;
  private authorityPending = false;
  private lastResponse = 0;
  private outgoingBytes = 0;
  private lastSend = 0;
  private outgoingWrites: { end: number; at: number }[] = [];
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private inputTimes: number[] = [];
  private snapshotTimes: number[] = [];
  token = "";
  private timeline = new SnapshotTimeline();
  private contactPresentation = new Map<string, number>();
  private displayedRemotes = new Map<
    string,
    { pose: Entity; target: Entity; at: number; smoothing: boolean }
  >();
  private contactOwner = "";
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
    this.closed = true;
    if (this.socket) this.disconnect(this.socket);
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    this.closed = false;
    this.welcomed = false;
    this.rtt = undefined;
    this.jitter = this.latency = this.received = this.snapshotInterval = 0;
    this.ack = -1;
    this.ackTimestamp = undefined;
    this.queued = undefined;
    this.inputTimes = [];
    this.snapshotTimes = [];
    this.resyncs = 0;
    this.hooks.status("connecting");
    this.socket = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
    );
    const socket = this.socket;
    this.lastResponse = performance.now();
    this.outgoingBytes = 0;
    this.lastSend = this.lastResponse;
    this.outgoingWrites = [];
    let checkedAt = this.lastResponse;
    this.heartbeat = setInterval(() => {
      if (this.socket !== socket) return;
      const now = performance.now();
      // A paused event loop must process queued replies before judging the link.
      if (now - checkedAt > 2000) this.lastResponse = now;
      checkedAt = now;
      if (now - this.lastResponse >= 5000) this.disconnect(socket);
      else if (this.welcomed) this.send({ type: "ping" });
    }, 1000);
    socket.binaryType = "arraybuffer";
    this.socket.onopen = () => {
      if (this.socket !== socket) return;
      this.send({
        type: "join",
        version: VERSION,
        name: this.name,
        color: this.color,
        character: this.character,
        token: this.token || undefined,
      });
    };
    this.socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let m;
      try {
        m =
          typeof event.data === "string"
            ? JSON.parse(event.data)
            : decodeSnapshot(event.data);
      } catch {
        return;
      }
      if (["welcome", "state", "pong"].includes(m.type))
        this.lastResponse = performance.now();
      if (m.type === "versionMismatch") {
        this.hooks.status("version mismatch; refresh the game");
        this.close();
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
        if (!this.send({ type: "ping" })) return;
        this.playerId = m.id;
        this.token = m.token;
        this.prediction = new Prediction(this.city ?? emptyCity(m.map), (point) =>
          this.worldReady(point),
        );
        this.authorityPending = false;
        this.seq = 0;
        this.frame = 0;
        this.entities.clear();
        this.timeline.reset();
        this.contactPresentation.clear();
        this.displayedRemotes.clear();
        this.contactOwner = "";
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
        this.queued = snapshot.queued;
        this.clock?.feedback(snapshot.queued);
        const entities = [...this.entities.values()];
        this.timeline.push(snapshot.time, entities, this.received);
        this.authorityPending = true;
        if (!this.prediction?.body) this.reconcile(now);
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
    socket.onclose = () => this.disconnect(socket);
    socket.onerror = () => {
      if (this.socket === socket) this.hooks.status("connection error");
    };
  }
  private disconnect(socket: WebSocket) {
    if (this.socket !== socket) return;
    this.socket = undefined;
    socket.close();
    this.welcomed = false;
    clearInterval(this.heartbeat);
    for (const request of this.debugRequests.values()) {
      clearTimeout(request.timer);
      request.reject(Error("Connection closed"));
    }
    this.debugRequests.clear();
    this.authorityPending = false;
    this.prediction?.reset();
    if (this.closed) return;
    this.hooks.status("reconnecting");
    this.retry = setTimeout(() => this.connect(), 1500);
  }
  send(data: object) {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    const now = performance.now();
    // bufferedAmount can still include delivered bytes until the browser resumes.
    if (now - this.lastSend > 250)
      for (const write of this.outgoingWrites) write.at = now;
    this.lastSend = now;
    const drained = this.outgoingBytes - socket.bufferedAmount;
    this.outgoingWrites = this.outgoingWrites.filter((write) => write.end > drained);
    if (socket.bufferedAmount && !this.outgoingWrites.length)
      this.outgoingWrites.push({ end: this.outgoingBytes, at: now });
    const message = JSON.stringify({ timestamp: now, ...data });
    const bytes = new TextEncoder().encode(message).byteLength;
    const oldest = this.outgoingWrites[0]?.at;
    // A few commands may queue briefly; never retain seconds of stale throttle.
    if (
      socket.bufferedAmount + bytes > 4096 ||
      (oldest !== undefined && now - oldest >= 250)
    ) {
      this.disconnect(socket);
      return false;
    }
    try {
      socket.send(message);
      this.outgoingBytes += bytes;
      this.outgoingWrites.push({ end: this.outgoingBytes, at: now });
      return true;
    } catch {
      this.disconnect(socket);
      return false;
    }
  }
  private reconcile(now: number) {
    if (!this.authorityPending) return;
    this.authorityPending = false;
    const player = this.entities.get(this.playerId);
    if (player)
      this.prediction?.reconcile(player, [...this.entities.values()], this.ack, now);
  }
  input(input: Input, timestamp = performance.now()) {
    if (
      this.socket?.readyState !== WebSocket.OPEN ||
      !this.welcomed ||
      !this.prediction
    )
      return;
    const frame: InputFrame = {
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
    if (!this.send({ type: "input", seq: frame.seq, timestamp, ...frame.input }))
      return;
    // Send controls first, then consume the latest authority before predicting.
    this.reconcile(performance.now());
    // A slot the server already simulated on held controls is acknowledged before its
    // command exists here; stepping it again would run that tick twice.
    if (frame.seq > this.ack) this.prediction.input(frame, [...this.entities.values()]);
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
      interpolationDelay: this.timeline.delay * 1000,
      snapshotsPerSecond: this.snapshotTimes.filter((at) => at >= now - 1000).length,
      inputsPerSecond: this.inputTimes.filter((at) => at >= now - 1000).length,
      seq: this.seq - 1,
      ack: this.ack,
      ackAge:
        this.ackTimestamp === undefined
          ? undefined
          : Math.max(0, now - this.ackTimestamp),
      pending: p?.pending.filter((frame) => frame.seq > this.ack).length ?? 0,
      queued: this.queued,
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
    this.reconcile(now);
    const result = this.timeline.sample(now);
    const presented = new Set<string>();
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
      if (this.contactOwner !== predicted.id) {
        this.contactPresentation.clear();
        this.displayedRemotes.clear();
        this.contactOwner = predicted.id;
      }
      for (const [id, until] of this.contactPresentation)
        if (until <= now) this.contactPresentation.delete(id);
      // Only interacting bodies leave the buffered timeline, not every nearby player.
      for (const neighbour of prediction?.neighbours ?? this.entities.values()) {
        if (neighbour.id === predicted.id || neighbour.vehicle) continue;
        const index = result.findIndex((e) => e.id === neighbour.id);
        const remote = index >= 0 ? result[index] : this.entities.get(neighbour.id);
        if (!remote) continue;
        const distance = Math.min(
          Math.hypot(remote.x - predicted.x, remote.z - predicted.z),
          Math.hypot(neighbour.x - predicted.x, neighbour.z - predicted.z),
        );
        const interacting = prediction?.contacts.has(neighbour.id);
        // Let interpolation catch up gradually after a provisional impact.
        if (interacting) this.contactPresentation.set(neighbour.id, now + 500);
        const remaining = (this.contactPresentation.get(neighbour.id) ?? now) - now;
        const weight = Math.max(0, Math.min(1, (24 - distance) / 12, remaining / 500));
        const previous = this.displayedRemotes.get(neighbour.id);
        if (weight === 0 && !previous?.smoothing) continue;
        let pose = interpolate(remote, neighbour, weight);
        let smoothing = weight > 0;
        if (previous) {
          const dt = Math.max(0, Math.min(0.1, (now - previous.at) / 1000));
          const reference = previous.smoothing ? pose : remote;
          const dx = reference.x - previous.target.x,
            dy = reference.y - previous.target.y,
            dz = reference.z - previous.target.z;
          const distance = Math.hypot(dx, dy, dz);
          const travel =
            Math.max(
              Math.hypot(previous.pose.vx, previous.pose.vy, previous.pose.vz),
              Math.hypot(pose.vx, pose.vy, pose.vz),
            ) * dt;
          const fraction = distance ? Math.min(1, travel / distance) : 0;
          const advanced = {
            ...previous.pose,
            x: previous.pose.x + dx * fraction,
            y: previous.pose.y + dy * fraction,
            z: previous.pose.z + dz * fraction,
            angle: wrap(previous.pose.angle + (pose.angularVelocity || 0) * dt),
          };
          smoothing ||=
            Math.hypot(advanced.x - pose.x, advanced.y - pose.y, advanced.z - pose.z) >
              0.01 || Math.abs(wrap(advanced.angle - pose.angle)) > 0.001;
          const target = pose;
          pose = interpolate(advanced, target, 1 - Math.exp(-12 * dt));
          this.displayedRemotes.set(neighbour.id, { pose, target, at: now, smoothing });
        } else {
          this.displayedRemotes.set(neighbour.id, {
            pose,
            target: pose,
            at: now,
            smoothing,
          });
        }
        presented.add(neighbour.id);
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
    const visible = new Set(result.map((e) => e.id));
    for (const id of this.displayedRemotes.keys())
      if (!visible.has(id)) this.displayedRemotes.delete(id);
    for (const e of result)
      if (!presented.has(e.id))
        this.displayedRemotes.set(e.id, {
          pose: e,
          target: e,
          at: now,
          smoothing: false,
        });
    return result;
  }
  close() {
    this.closed = true;
    this.welcomed = false;
    clearInterval(this.heartbeat);
    clearTimeout(this.retry);
    if (this.socket) this.disconnect(this.socket);
  }
}
