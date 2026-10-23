import { encode, decode } from "@msgpack/msgpack";
import type { Character } from "../../shared/character.ts";
import type { ClientMessage } from "../../shared/generated/ClientMessage.ts";
import type { ServerMessage } from "../../shared/generated/ServerMessage.ts";
import type { Controls } from "../../shared/generated/Controls.ts";
import { mapManifestSchema, type MapManifest } from "../../shared/city-stream.ts";
import type { Pickup, PlayerPosition, PlayerSummary } from "../../shared/protocol.ts";
import type { DebugCommand, DebugState } from "../../shared/debug.ts";
import type { DebrisState, PredictedImpacts } from "../../shared/destruction.ts";
import type { GrenadeState } from "../../shared/grenades.ts";
import type { DebrisClock } from "../world/destruction.ts";
import type { City, Entity, Input, WorldEvent } from "../../shared/world.ts";
import type { InputClock } from "../input/clock.ts";
import { TUNING } from "../../shared/catalog.ts";
import { InputStamper } from "./lead.ts";
import { Prediction, loadPhysics, withPredicted } from "./prediction.ts";
import { SnapshotTimeline } from "./timeline.ts";

export const VERSION = 1;
/** Ticks an input should arrive before the server simulates it. */

export interface Welcome {
  id: string;
  map: MapManifest;
  debug: boolean;
}
export interface StateMessage {
  entities: Entity[];
  pickups: Pickup[];
  events: WorldEvent[];
  time: number;
  day: number;
  dayRate?: number;
  players: number;
  grenades?: GrenadeState[];
  debris?: DebrisState[];
}
export interface NetworkHooks {
  welcome: (m: Welcome) => void;
  state: (m: StateMessage) => void;
  chat: (name: string, text: string) => void;
  status: (state: string) => void;
  roster?: (players: PlayerSummary[]) => void;
  positions?: (players: PlayerPosition[]) => void;
  destruction?: (brokenProps: string[]) => void;
}

type Edge = Pick<Controls, "interact" | "drop" | "reload" | "jetpack" | "equip">;

/**
 * The browser side of the Rust server's protocol: msgpack over one WebSocket,
 * tick-stamped inputs sent a little ahead of the server, delta snapshots applied
 * over the acked base, and local prediction through the shared wasm physics.
 */
export class GameNetwork {
  socket: WebSocket | undefined;
  entities = new Map<string, Entity>();
  prediction: Prediction | undefined;
  playerId = "";
  predictedImpacts: PredictedImpacts = new Map();
  debrisClock: DebrisClock | undefined;
  clock: InputClock | undefined;
  worldReady = (_point: { x: number; z: number }) => true;
  seq = 0;
  /** The controls of the newest sent input, which the server holds through ticks with none. */
  private lastInput: Input | undefined;
  serverTime = 0;
  received = 0;
  latency = 0;
  rtt: number | undefined;
  jitter = 0;
  ack: number | undefined;
  lead = 0;
  private serverTick = 0;
  private stamper = new InputStamper();
  private edge: Edge = { interact: false, drop: false, reload: false, jetpack: false };
  private welcomed = false;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private lastDisconnect: string | undefined;
  private reconnects = 0;
  private lastResponse = 0;
  private snapshotTimes: number[] = [];
  private inputTimes: number[] = [];
  private debugSerial = 0;
  private debugRequests = new Map<
    number,
    { resolve: (state: DebugState) => void; reject: (error: Error) => void }
  >();
  private timeline = new SnapshotTimeline();
  constructor(
    private hooks: NetworkHooks,
    private name: string,
    private color: string,
    private city?: City,
    private character?: Character,
  ) {}
  connect() {
    this.closed = false;
    if (this.socket) this.disconnect(this.socket);
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    this.hooks.status(this.lastDisconnect ? "reconnecting" : "connecting");
    const socket = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
    );
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    let pingAt = 0;
    this.heartbeat = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
      const now = performance.now();
      if (this.lastResponse && now - this.lastResponse > 5000)
        this.disconnect(socket, "No response from the server");
      else if (now - pingAt >= 1000) {
        pingAt = now;
        this.send({ type: "ping", timestamp: now });
      }
    }, 250);
    socket.onopen = async () => {
      if (this.socket !== socket) return;
      await loadPhysics();
      if (this.socket !== socket) return;
      this.send({
        type: "join",
        version: VERSION,
        name: this.name,
        color: this.color,
        character: this.character,
      });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let m: ServerMessage;
      try {
        m = decode(new Uint8Array(event.data as ArrayBuffer)) as ServerMessage;
      } catch {
        return;
      }
      this.lastResponse = performance.now();
      if (m.type === "welcome") this.welcome(m);
      else if (m.type === "state") this.state(m);
      else if (m.type === "roster") this.hooks.roster?.(m.players);
      else if (m.type === "positions") this.hooks.positions?.(m.players);
      else if (m.type === "chat") this.hooks.chat(m.name, m.text);
      else if (m.type === "debugResult") {
        const pending = this.debugRequests.get(m.requestId);
        if (!pending) return;
        this.debugRequests.delete(m.requestId);
        if (m.error || !m.state) pending.reject(Error(m.error || "Missing state"));
        else pending.resolve(m.state as DebugState);
      } else if (m.type === "pong") {
        const rtt = performance.now() - m.timestamp;
        this.jitter =
          this.rtt === undefined
            ? 0
            : this.jitter * 0.8 + Math.abs(rtt - this.rtt) * 0.2;
        this.rtt = this.rtt === undefined ? rtt : this.rtt * 0.8 + rtt * 0.2;
        this.latency = this.rtt / 2;
      }
    };
    socket.onclose = () => this.disconnect(socket, "Connection closed");
    socket.onerror = () => this.disconnect(socket, "Connection error");
  }
  private welcome(m: Extract<ServerMessage, { type: "welcome" }>) {
    if (m.version !== VERSION) {
      this.hooks.status("version mismatch; refresh the game");
      this.close();
      return;
    }
    const map = mapManifestSchema.safeParse(m.map);
    if (!map.success) {
      this.hooks.status("bad city manifest");
      this.close();
      return;
    }
    this.welcomed = true;
    this.playerId = m.id;
    this.serverTick = m.tick;
    this.stamper.reset(m.tick);
    this.seq = 0;
    this.lastInput = undefined;
    this.received = performance.now();
    this.entities.clear();
    this.timeline.reset();
    this.prediction = new Prediction(this.city ?? {});
    this.hooks.status("connected");
    this.hooks.welcome({ id: m.id, map: map.data, debug: m.debug });
  }
  private state(m: Extract<ServerMessage, { type: "state" }>) {
    const now = performance.now();
    if (m.base === null) this.entities.clear();
    for (const id of m.removed) this.entities.delete(id);
    for (const e of m.entities) this.entities.set(e.id, e as Entity);
    this.serverTick = m.tick;
    this.serverTime = m.time;
    this.ack = m.ack ?? undefined;
    this.lead = m.lead;
    this.stamper.feedback(m.lead);
    this.received = now;
    this.snapshotTimes.push(now);
    this.snapshotTimes = this.snapshotTimes.filter((at) => at >= now - 1000);
    const entities = [...this.entities.values()];
    this.timeline.push(m.time, entities, now);
    if (this.city) this.prediction?.syncStatic(this.city);
    const me = this.entities.get(this.playerId);
    const controlledVehicle = me?.vehicle ? this.entities.get(me.vehicle) : undefined;
    if (me && m.you)
      this.prediction?.reconcile(me, controlledVehicle, m.you, this.ack, entities);
    if (m.broken) this.hooks.destruction?.(m.broken);
    this.hooks.state({
      entities,
      pickups: m.pickups as Pickup[],
      events: m.events as WorldEvent[],
      time: m.time,
      day: m.day,
      dayRate: m.dayRate,
      players: m.players,
      grenades: m.grenades,
      debris: m.debris as DebrisState[],
    });
  }
  private disconnect(socket: WebSocket, reason?: string) {
    if (this.socket !== socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    if (socket.readyState < WebSocket.CLOSING) socket.close();
    this.socket = undefined;
    clearInterval(this.heartbeat);
    this.welcomed = false;
    this.prediction?.reset();
    this.timeline.reset();
    if (reason) this.lastDisconnect = reason;
    if (this.closed) return;
    this.reconnects++;
    this.hooks.status("reconnecting");
    this.retry = setTimeout(() => this.connect(), 1000);
  }
  close() {
    this.closed = true;
    clearTimeout(this.retry);
    if (this.socket) this.disconnect(this.socket);
  }
  send(message: ClientMessage | { type: string; [key: string]: unknown }): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    switch (message.type) {
      case "interact":
      case "drop":
      case "reload":
      case "jetpack":
        // Edge actions ride on the next input frame instead of a separate message.
        this.edge[message.type] = true;
        return true;
      case "equip":
        this.edge.equip = message.slot as number;
        return true;
      case "join":
      case "input":
      case "chat":
      case "ping":
      case "debugCommand":
        break;
      default:
        return true;
    }
    try {
      this.socket.send(encode(message, { ignoreUndefined: true }));
      return true;
    } catch {
      this.disconnect(this.socket, "Socket send failed");
      return false;
    }
  }
  debug(command: DebugCommand): Promise<DebugState> {
    if (this.socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(Error("Not connected to the server"));
    const requestId = ++this.debugSerial;
    return new Promise<DebugState>((resolve, reject) => {
      this.debugRequests.set(requestId, { resolve, reject });
      if (!this.send({ type: "debugCommand", requestId, command })) {
        this.debugRequests.delete(requestId);
        reject(Error("Debug command could not be sent"));
      }
    });
  }
  /** Current server tick, extrapolated from the last snapshot. */
  private serverTickAt(now: number) {
    return this.serverTick + (now - this.received) / (TUNING.tick * 1000);
  }
  input(input: Input, timestamp = performance.now()) {
    if (
      this.socket?.readyState !== WebSocket.OPEN ||
      !this.welcomed ||
      !this.prediction
    )
      return;
    const tick = this.stamper.stamp(this.serverTickAt(timestamp));
    // Already a tick or more ahead of the aim: the server runs one input per tick, so an
    // extra one would only queue. The next slot carries the current controls.
    if (tick === undefined) return;
    const controls: Controls = {
      up: input.up,
      down: input.down,
      left: input.left,
      right: input.right,
      moveX: input.moveX,
      moveY: input.moveY,
      brake: input.brake,
      sprint: input.sprint ?? false,
      ascend: input.ascend,
      descend: input.descend,
      attack: input.attack,
      aim: input.aim,
      ...this.edge,
    };
    this.edge = { interact: false, drop: false, reload: false, jetpack: false };
    if (!this.send({ type: "input", tick, ack: this.serverTick, controls })) return;
    // A jump in the stamps skips server ticks. It runs them on the held controls, so the
    // predicted body must step through them too or it trails the server by a tick or two.
    if (this.lastInput && tick > this.seq + 1 && tick - this.seq <= 8)
      for (let held = this.seq + 1; held < tick; held++)
        this.prediction.input(held, this.lastInput);
    this.seq = tick;
    this.lastInput = input;
    this.prediction.input(tick, input);
    this.inputTimes.push(timestamp);
    this.inputTimes = this.inputTimes.filter((at) => at >= timestamp - 1000);
  }
  /** Interpolated remote bodies plus the predicted local one. */
  renderEntities(now: number, _input?: Input): Entity[] {
    const frame = this.timeline.sample(now);
    const me = this.prediction?.render(now);
    return me
      ? withPredicted(frame, me, this.playerId, this.prediction?.drawnCars)
      : frame;
  }
  stats(now = performance.now()) {
    const p = this.prediction;
    const interval =
      this.snapshotTimes.length > 1
        ? (now - this.snapshotTimes[0]) / (this.snapshotTimes.length - 1)
        : undefined;
    return {
      connected: this.welcomed && this.socket?.readyState === WebSocket.OPEN,
      lastDisconnect: this.lastDisconnect,
      reconnects: this.reconnects,
      rtt: this.rtt,
      jitter: this.jitter,
      snapshotAge: this.received ? Math.max(0, now - this.received) : undefined,
      snapshotInterval: interval,
      interpolationDelay: this.timeline.delay * 1000,
      snapshotsPerSecond: this.snapshotTimes.length,
      inputsPerSecond: this.inputTimes.length,
      seq: this.seq,
      ack: this.ack ?? -1,
      ackAge:
        this.ack === undefined ? undefined : (this.seq - this.ack) * TUNING.tick * 1000,
      pending: p?.pending.length ?? 0,
      queued: this.lead,
      prediction: p?.body ? "predicted" : "none",
      correction: p?.lastCorrection.distance ?? 0,
      angle: ((p?.lastCorrection.angle ?? 0) * 180) / Math.PI,
      offset: p ? Math.hypot(p.offset.x, p.offset.z) : 0,
      corrections: p?.corrections ?? 0,
      buffered: this.socket?.bufferedAmount ?? 0,
      resyncs: 0,
      serverTime: this.serverTime,
    };
  }
}
