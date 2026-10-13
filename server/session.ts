import { encodeSnapshot, type EntityPatch } from "../shared/codec.ts";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { Server } from "node:http";
import {
  VERSION,
  messageSchema,
  type InputFrame,
  type Snapshot,
  type PlayerRoster,
  type PlayerSummary,
} from "../shared/protocol.ts";
import { idle, type Entity } from "../shared/world.ts";
import { TUNING, isWeaponKind, type VehicleModel } from "../shared/catalog.ts";
import { Simulation } from "./simulation.ts";
import { executeDebug } from "./debug.ts";
import type { MapManifest } from "../shared/city-stream.ts";
interface Client {
  id?: string;
  token: string;
  queue: InputFrame[];
  ack: number;
  ackTimestamp?: number;
  lastSeq: number;
  last: number;
  lastInput: number;
  count: number;
  window: number;
  actions: Map<string, number>;
  frame: number;
  known: Map<string, Map<string, string | undefined>>;
  view?: { x: number; z: number };
  rosterKey?: string;
  destructionKey?: string;
}
export class Sessions {
  clients = new Map<WebSocket, Client>();
  detached = new Map<string, { id: string; expires: number }>();
  bytes = 0;
  rejected = 0;
  frames = 0;
  debug: boolean;
  wss: WebSocketServer;
  constructor(
    server: Server,
    readonly sim: Simulation,
    production: boolean,
    readonly map: MapManifest,
  ) {
    this.debug = process.env.ALLOW_DEBUG === "1" || !production;
    const publicUrl = process.env.PUBLIC_ORIGIN && new URL(process.env.PUBLIC_ORIGIN);
    if (publicUrl && !["http:", "https:"].includes(publicUrl.protocol))
      throw Error("PUBLIC_ORIGIN must be an HTTP or HTTPS URL");
    const publicOrigin = publicUrl ? publicUrl.origin : undefined;
    this.wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });
    this.wss.on("connection", (ws, req) => {
      let valid = true;
      try {
        // The local preview proxy overwrites forwarded host before rewriting Host.
        const localProxy = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          req.socket.remoteAddress ?? "",
        );
        const host =
          localProxy && req.headers["x-forwarded-host"]
            ? req.headers["x-forwarded-host"]
            : req.headers.host;
        valid =
          !req.headers.origin ||
          req.headers.origin === publicOrigin ||
          new URL(req.headers.origin).host === host;
      } catch {
        valid = false;
      }
      if (!valid) {
        ws.close(1008, "Origin rejected");
        return;
      }
      if (this.clients.size >= TUNING.maxPlayers) {
        ws.close(1013, "City is full");
        return;
      }
      const c: Client = {
        token: randomUUID(),
        queue: [],
        ack: -1,
        lastSeq: -1,
        last: Date.now(),
        lastInput: 0,
        count: 0,
        window: Date.now(),
        actions: new Map(),
        frame: 0,
        known: new Map(),
      };
      this.clients.set(ws, c);
      ws.on("message", (raw) => this.message(ws, c, String(raw)));
      ws.on("close", () => {
        if (c.id) {
          this.sim.disconnect(c.id);
          this.detached.set(c.token, { id: c.id, expires: Date.now() + 15000 });
        }
        this.clients.delete(ws);
      });
    });
  }
  send(ws: WebSocket, data: object) {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 256_000) return;
    data = { time: this.sim.time, ...data };
    const payload =
      (data as Snapshot).type === "state"
        ? encodeSnapshot(data as Snapshot)
        : JSON.stringify(data);
    this.bytes +=
      typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength;
    ws.send(payload);
  }
  private message(ws: WebSocket, c: Client, raw: string) {
    const now = Date.now();
    if (now - c.window > 1000) {
      c.count = 0;
      c.window = now;
    }
    if (++c.count > 100) {
      this.rejected++;
      return;
    }
    let parsed;
    try {
      parsed = messageSchema.safeParse(JSON.parse(raw));
    } catch {
      this.rejected++;
      return;
    }
    if (!parsed.success) {
      this.rejected++;
      return;
    }
    const m = parsed.data;
    c.last = now;
    if (m.type === "ping") {
      this.send(ws, { type: "pong", timestamp: m.timestamp, time: this.sim.time });
      return;
    }
    if (m.type === "join" && !c.id) {
      const old = m.token ? this.detached.get(m.token) : undefined;
      const active = m.token
        ? [...this.clients.entries()].find(
            ([peer, session]) => peer !== ws && session.token === m.token && session.id,
          )
        : undefined;
      if (active && active[1].id) {
        // A reconnect may beat the old socket's close event under load.
        c.id = active[1].id;
        c.token = m.token!;
        this.sim.disconnect(c.id);
        active[1].id = undefined;
        active[1].queue = [];
        this.clients.delete(active[0]);
        active[0].close(1000, "Session restored elsewhere");
        this.detached.delete(c.token);
      } else if (old && old.expires > now && this.sim.entities.has(old.id)) {
        c.id = old.id;
        c.token = m.token!;
        this.detached.delete(c.token);
      } else {
        const name = m.name.replace(/[<>\x00-\x1f]/g, "") || "Stranger";
        c.id = this.sim.join(name, m.color, m.character).id;
      }
      this.send(ws, {
        type: "welcome",
        version: VERSION,
        id: c.id,
        token: c.token,
        map: this.map,
        debug: this.debug,
      });
      return;
    }
    if (!c.id) return;
    const p = this.sim.entities.get(c.id);
    if (!p) return;
    if (m.type === "input") {
      if (m.seq <= c.lastSeq) {
        this.rejected++;
        return;
      }
      c.lastSeq = m.seq;
      c.lastInput = now;
      const { type, seq, timestamp, ...input } = m;
      c.queue.push({ seq, timestamp, input });
      // An 80 ms client wakeup batches three ticks; retain them without slowing authority.
      if (c.queue.length > 3) c.queue.shift();
      return;
    }
    if (m.type === "resync") {
      c.frame = 0;
      c.known.clear();
      return;
    }
    if (
      (m.type === "debug" || m.type === "debugCommand" || m.type === "debugView") &&
      !this.debug
    ) {
      this.rejected++;
      if (m.type === "debugCommand")
        this.send(ws, {
          type: "debugResult",
          requestId: m.requestId,
          error: "Debug access is disabled",
        });
      return;
    }
    if (m.type === "debugView") {
      c.view = m.center || undefined;
      return;
    }
    if (m.type === "debugCommand") {
      if (now - (c.actions.get(m.type) ?? -Infinity) < 100) {
        this.send(ws, {
          type: "debugResult",
          requestId: m.requestId,
          error: "Debug action rate limit",
        });
        return;
      }
      c.actions.set(m.type, now);
      try {
        const state = executeDebug(this.sim, p, m.command);
        if (m.command.kind === "teleport") c.queue = [];
        this.send(ws, { type: "debugResult", requestId: m.requestId, state });
      } catch (error) {
        this.send(ws, {
          type: "debugResult",
          requestId: m.requestId,
          error: String(error),
        });
      }
      return;
    }
    if (now - (c.actions.get(m.type) ?? -Infinity) < 100) return;
    c.actions.set(m.type, now);
    if (m.type === "lights") this.sim.toggleLights(c.id);
    if (m.type === "interact") this.sim.interact(c.id);
    if (m.type === "drop") this.sim.inventory.drop(p, this.sim.time);
    if (m.type === "reload") this.sim.inventory.reload(p, this.sim.time);
    if (m.type === "equip") this.sim.inventory.equip(p, m.slot);
    if (m.type === "jetpack" && p.jetpack && !p.vehicle && !p.down)
      p.jetpack.active = !p.jetpack.active;
    if (m.type === "chat")
      for (const peer of this.clients.keys())
        this.send(peer, { type: "chat", name: p.name, text: m.text });
    if (m.type === "debug" && this.debug) {
      const models: Record<string, VehicleModel> = {
        car: "sedan",
        sport: "sport",
        van: "van",
        helicopter: "scout",
        utility: "utility",
        plane: "plane",
      };
      const model = models[m.kind];
      if (model && this.sim.entities.size < 300) {
        for (let radius = 5; radius < 30; radius += 3) {
          const point = Array.from({ length: 12 }, (_, i) => ({
            x: p.x + Math.sin((i * Math.PI) / 6) * radius,
            z: p.z + Math.cos((i * Math.PI) / 6) * radius,
          })).find(
            (pos) =>
              !this.sim.blocked(pos.x, pos.z, 5) &&
              !this.sim.spatial
                .query(pos.x, pos.z, 5)
                .some((e) => !e.vehicle && Math.hypot(e.x - pos.x, e.z - pos.z) < 5),
          );
          if (point) {
            const kind =
              model === "scout" || model === "utility"
                ? "helicopter"
                : model === "plane"
                  ? "plane"
                  : "car";
            this.sim.spawn(kind, point.x, point.z, undefined, model);
            break;
          }
        }
      }
      if (isWeaponKind(m.kind)) this.sim.inventory.give(p, m.kind);
      if (m.kind === "jetpack") p.jetpack = { fuel: 45, active: false };
      if (m.kind === "heal") {
        this.sim.repair(p);
        if (p.vehicle) {
          const v = this.sim.entities.get(p.vehicle);
          if (v) this.sim.repair(v);
        }
      }
      if (m.kind === "respawn") this.sim.respawn(p);
      if (m.kind === "damage" && p.vehicle) {
        const v = this.sim.entities.get(p.vehicle);
        if (v) this.sim.damage(v, (v.maxHealth || 100) * 0.8);
      }
      if (m.kind === "day") this.sim.day = 12;
      if (m.kind === "night") this.sim.day = 0;
    }
  }
  tick() {
    const now = Date.now();
    for (const [ws, c] of this.clients) {
      if (now - c.last > 30000) {
        ws.close(1001, "Idle connection");
        continue;
      }
      if (!c.id) continue;
      const frame = c.queue.shift();
      if (frame) {
        c.ack = frame.seq;
        c.ackTimestamp = frame.timestamp;
        this.sim.inputs.set(c.id, frame.input);
      } else if (now - c.lastInput > 250) this.sim.inputs.set(c.id, idle());
    }
    for (const [token, d] of this.detached)
      if (d.expires < now) {
        this.sim.leave(d.id);
        this.detached.delete(token);
      }
  }
  broadcast() {
    const events = this.sim.drainEvents();
    const roster: PlayerRoster = { type: "roster", players: this.roster() },
      rosterKey = JSON.stringify(roster);
    const destruction = {
        type: "destruction",
        brokenProps: [...this.sim.destruction.broken].sort(),
      },
      destructionKey = JSON.stringify(destruction);
    this.frames++;
    const encodedEntities = new Map<
      string,
      { rounded: Entity; fields: Map<string, string | undefined> }
    >();
    for (const [ws, c] of this.clients) {
      if (!c.id) continue;
      const p = this.sim.entities.get(c.id);
      if (!p) continue;
      const center = this.debug && c.view ? c.view : p;
      const visible = new Map(
        this.sim.spatial
          .query(center.x, center.z, TUNING.interestRadius)
          .filter(
            (e) => Math.hypot(e.x - center.x, e.z - center.z) <= TUNING.interestRadius,
          )
          .map((e) => [e.id, e]),
      );
      visible.set(p.id, p);
      if (p.vehicle) {
        const v = this.sim.entities.get(p.vehicle);
        if (v) visible.set(v.id, v);
      }
      for (const other of this.sim.entities.values())
        if (other.kind === "player" && other.vehicle && visible.has(other.vehicle))
          visible.set(other.id, other);
      const full = c.frame === 0 || this.frames % 30 === 0,
        entities: EntityPatch[] = [],
        known = new Map<string, Map<string, string | undefined>>();
      for (const [id, e] of visible) {
        let encoded = encodedEntities.get(id);
        if (!encoded) {
          const rounded = {
            ...e,
            x: +e.x.toFixed(3),
            z: +e.z.toFixed(3),
            y: +e.y.toFixed(3),
            vx: +e.vx.toFixed(3),
            vz: +e.vz.toFixed(3),
            angle: +e.angle.toFixed(5),
          };
          encoded = {
            rounded,
            fields: new Map(
              Object.entries(rounded).map(([key, value]) => [
                key,
                JSON.stringify(value),
              ]),
            ),
          };
          encodedEntities.set(id, encoded);
        }
        const { rounded, fields } = encoded;
        known.set(id, fields);
        if (full || !c.known.has(id)) entities.push(rounded);
        else {
          const previous = c.known.get(id)!,
            current = rounded as unknown as Record<string, unknown>,
            patch: Record<string, unknown> = { id };
          for (const key of new Set([...previous.keys(), ...fields.keys()]))
            if (previous.get(key) !== fields.get(key))
              patch[key] = current[key] ?? null;
          if (Object.keys(patch).length > 1 || id === p.id || id === p.vehicle)
            entities.push(patch as EntityPatch);
        }
      }
      const snapshot: Snapshot = {
        type: "state",
        version: VERSION,
        frame: this.frames,
        base: full ? 0 : c.frame,
        full,
        time: this.sim.time,
        day: this.sim.day,
        dayRate: this.sim.dayRate,
        ack: c.ack,
        ackTimestamp: c.ackTimestamp,
        entities,
        removed: [...c.known.keys()].filter((id) => !known.has(id)),
        events: events.filter(
          (e) => Math.hypot(e.x - p.x, e.z - p.z) < TUNING.interestRadius,
        ),
        pickups: [...this.sim.inventory.pickups.values()].filter(
          (e) => Math.hypot(e.x - p.x, e.z - p.z) < TUNING.interestRadius,
        ),
        players: roster.players.length,
        debris: this.sim.destruction.snapshot(center, TUNING.interestRadius),
        grenades: this.sim.grenades.snapshot(center.x, center.z, TUNING.interestRadius),
      };
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 256_000) {
        if (c.rosterKey !== rosterKey) {
          this.send(ws, roster);
          c.rosterKey = rosterKey;
        }
        if (c.destructionKey !== destructionKey) {
          this.send(ws, destruction);
          c.destructionKey = destructionKey;
        }
        this.send(ws, snapshot);
        c.known = known;
        c.frame = this.frames;
      }
    }
  }
  close() {
    for (const ws of this.clients.keys()) ws.close(1001, "Server restarting");
    this.wss.close();
  }
  /** Connected, joined sessions only; spatial interest and reconnect ghosts do not affect membership. */
  roster(): PlayerSummary[] {
    const players = new Map<string, PlayerSummary>();
    for (const [ws, c] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN || !c.id) continue;
      const p = this.sim.entities.get(c.id);
      if (p?.kind === "player")
        players.set(p.id, { id: p.id, name: p.name || "Stranger", color: p.color });
    }
    return [...players.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
