import {
  generateCity,
  idle,
  LIMIT,
  ROADS,
  signal,
  random,
  type Entity,
  type Input,
  type Kind,
} from "../shared/world.ts";
export class Simulation {
  city = generateCity();
  entities = new Map<string, Entity>();
  inputs = new Map<string, Input>();
  time = 0;
  day = 16.5;
  events: { kind: string; x: number; z: number; y: number }[] = [];
  serial = 0;
  constructor() {
    const r = random(982);
    for (let i = 0; i < 42; i++) {
      const vertical = i % 2 === 0;
      const road = ROADS[i % 7];
      const direction = i % 4 < 2 ? 1 : -1;
      const e = this.spawn(
        "car",
        vertical ? road + direction * 3.5 : r() * 380 - 190,
        vertical ? r() * 380 - 190 : road - direction * 3.5,
      );
      e.angle = (vertical ? 0 : Math.PI / 2) + (direction < 0 ? Math.PI : 0);
      e.ai = true;
    }
    for (let i = 0; i < 65; i++) {
      const e = this.spawn(
        "pedestrian",
        ROADS[i % 7] + (i % 2 ? 11 : -11),
        r() * 380 - 190,
      );
      e.angle = i % 2 ? 0 : Math.PI;
      e.ai = true;
    }
    this.spawn("car", 4, 25);
    this.spawn("helicopter", 0, 34);
    this.spawn("plane", 150, 0);
  }
  spawn(kind: Kind, x: number, z: number, color?: string) {
    const id = `e${++this.serial}`,
      e: Entity = {
        id,
        kind,
        x,
        z,
        y: 0,
        angle: 0,
        vx: 0,
        vz: 0,
        vy: 0,
        color:
          color ||
          ["#e8b63f", "#e86551", "#55a9b8", "#f3eee0", "#80a177"][
            this.serial % 5
          ],
        health: 100,
      };
    this.entities.set(id, e);
    return e;
  }
  join(name: string, color: string) {
    const e = this.spawn("player", 11, 25, color);
    e.name = name;
    e.weapon = "fists";
    this.inputs.set(e.id, idle());
    return e;
  }
  leave(id: string) {
    const p = this.entities.get(id);
    if (p?.vehicle) {
      const v = this.entities.get(p.vehicle);
      if (v) v.driver = undefined;
    }
    this.entities.delete(id);
    this.inputs.delete(id);
  }
  blocked(x: number, z: number, r = 0.6) {
    return (
      Math.abs(x) > LIMIT ||
      Math.abs(z) > LIMIT ||
      this.city.buildings.some(
        (b) =>
          Math.abs(x - b.x) < b.w / 2 + r && Math.abs(z - b.z) < b.d / 2 + r,
      )
    );
  }
  interact(id: string) {
    const p = this.entities.get(id);
    if (!p) return;
    if (p.vehicle) {
      const v = this.entities.get(p.vehicle);
      if (!v || v.y > 2) return;
      for (const side of [1, -1]) {
        const x = v.x + Math.cos(v.angle) * 3 * side,
          z = v.z - Math.sin(v.angle) * 3 * side;
        if (!this.blocked(x, z)) {
          p.x = x;
          p.z = z;
          p.vehicle = undefined;
          v.driver = undefined;
          return;
        }
      }
      return;
    }
    const v = [...this.entities.values()]
      .filter(
        (e) =>
          ["car", "helicopter", "plane"].includes(e.kind) &&
          !e.driver &&
          e.y < 2 &&
          Math.hypot(e.x - p.x, e.z - p.z) < 6,
      )
      .sort(
        (a, b) =>
          Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z),
      )[0];
    if (v) {
      p.vehicle = v.id;
      v.driver = id;
      v.ai = false;
      return;
    }
    const item = this.city.pickups.find(
      (e) => Math.hypot(e.x - p.x, e.z - p.z) < 3,
    );
    if (item) p.weapon = item.weapon;
  }
  attack(p: Entity) {
    if ((p.cooldown || 0) > 0 || p.vehicle || p.down) return;
    p.cooldown = p.weapon === "pistol" ? 0.3 : 0.55;
    const range = p.weapon === "pistol" ? 35 : p.weapon === "bat" ? 3 : 2.1;
    this.events.push({
      kind: p.weapon === "pistol" ? "shot" : "hit",
      x: p.x,
      z: p.z,
      y: 1,
    });
    for (const e of this.entities.values()) {
      if (e.id === p.id || e.y > 3) continue;
      const dx = e.x - p.x,
        dz = e.z - p.z,
        d = Math.hypot(dx, dz);
      if (
        d < range &&
        d > 0 &&
        (dx * Math.sin(p.angle) + dz * Math.cos(p.angle)) / d > 0.8 &&
        !this.city.buildings.some((b) => {
          for (let t = 0; t < d; t += 1) {
            if (
              Math.abs(p.x + (dx * t) / d - b.x) < b.w / 2 &&
              Math.abs(p.z + (dz * t) / d - b.z) < b.d / 2
            )
              return true;
          }
          return false;
        })
      ) {
        e.health -= p.weapon === "pistol" ? 25 : 20;
        e.vx += Math.sin(p.angle) * 5;
        e.vz += Math.cos(p.angle) * 5;
        if (e.health <= 0) {
          e.down = 5;
          e.health = 0;
        }
        break;
      }
    }
  }
  tick(dt: number) {
    this.time += dt;
    this.day = (this.day + dt / 75) % 24;
    this.events = [];
    for (const e of this.entities.values()) {
      e.cooldown = Math.max(0, (e.cooldown || 0) - dt);
      if (e.down) {
        e.down -= dt;
        if (e.down <= 0) {
          e.down = 0;
          e.health = 100;
          if (e.kind === "player") {
            e.x = 11;
            e.z = 25;
          }
        }
        continue;
      }
      if (e.kind === "player" && e.vehicle) continue;
      const input = this.inputs.get(e.driver || e.id) || idle();
      const ox = e.x,
        oz = e.z;
      if (e.kind === "player" || e.kind === "pedestrian") {
        let dx = 0,
          dz = 0;
        if (e.kind === "player") {
          dx = Number(input.right) - Number(input.left);
          dz = Number(input.up) - Number(input.down);
          if (input.attack) this.attack(e);
        } else {
          dz = Math.cos(e.angle);
          if (Math.abs(e.z) > 202) e.angle += Math.PI;
          const danger = [...this.entities.values()].find(
            (v) =>
              v.kind === "car" &&
              Math.hypot(v.x - e.x, v.z - e.z) < 7 &&
              Math.hypot(v.vx, v.vz) > 4,
          );
          if (danger) dx = Math.sign(e.x - danger.x) * 2;
          const crossing = ROADS.some((r) => Math.abs(e.z - r) < 12);
          if (crossing && signal(this.time, "z") !== "green") dz = 0;
        }
        const length = Math.hypot(dx, dz);
        if (length) {
          e.angle = Math.atan2(dx, dz);
          e.vx = (dx / length) * (input.brake ? 8 : 4.5);
          e.vz = (dz / length) * (input.brake ? 8 : 4.5);
        } else {
          e.vx *= Math.exp(-12 * dt);
          e.vz *= Math.exp(-12 * dt);
        }
      } else {
        const forward = e.vx * Math.sin(e.angle) + e.vz * Math.cos(e.angle);
        let throttle = Number(input.up) - Number(input.down),
          steer = Number(input.right) - Number(input.left);
        if (e.ai) {
          throttle = forward < 10 ? 1 : 0;
          const vertical = Math.abs(Math.cos(e.angle)) > 0.5;
          const coordinate = vertical ? e.z : e.x;
          const direction = Math.sign(
            vertical ? Math.cos(e.angle) : Math.sin(e.angle),
          );
          const next = ROADS.find(
            (r) =>
              (r - coordinate) * direction > 8 &&
              (r - coordinate) * direction < 17,
          );
          const front = [...this.entities.values()].some(
            (v) =>
              v.id !== e.id &&
              v.kind === "car" &&
              Math.hypot(v.x - e.x, v.z - e.z) < 7 &&
              (v.x - e.x) * Math.sin(e.angle) +
                (v.z - e.z) * Math.cos(e.angle) >
                0,
          );
          if (
            (next !== undefined &&
              signal(this.time, vertical ? "z" : "x") !== "green") ||
            front
          ) {
            throttle = 0;
            e.vx *= Math.exp(-7 * dt);
            e.vz *= Math.exp(-7 * dt);
          }
          if (e.x > 211) e.x = -210;
          if (e.z > 211) e.z = -210;
          if (e.x < -211) e.x = 210;
          if (e.z < -211) e.z = 210;
        }
        e.angle +=
          steer *
          Math.min(Math.abs(forward) / 5, 1) *
          1.4 *
          dt *
          (forward < 0 ? -1 : 1);
        const sx = Math.sin(e.angle),
          sz = Math.cos(e.angle);
        const lateral = e.vx * sz - e.vz * sx;
        const grip = e.kind === "car" ? (input.brake ? 1.2 : 8) : 2;
        e.vx -= sz * lateral * Math.min(1, grip * dt);
        e.vz += sx * lateral * Math.min(1, grip * dt);
        const acceleration = e.kind === "plane" ? 17 : 13;
        e.vx += sx * throttle * acceleration * dt;
        e.vz += sz * throttle * acceleration * dt;
        const drag = input.brake ? 1.3 : 0.25;
        e.vx *= Math.exp(-drag * dt);
        e.vz *= Math.exp(-drag * dt);
        const speed = Math.hypot(e.vx, e.vz);
        if (speed > 48) {
          e.vx *= 48 / speed;
          e.vz *= 48 / speed;
        }
        if (e.kind === "helicopter" && e.driver) {
          e.vy = (Number(input.ascend) - Number(input.descend)) * 9;
          e.y = Math.max(0, Math.min(55, e.y + e.vy * dt));
        } else if (e.kind === "plane" && e.driver) {
          e.vy +=
            (speed > 19
              ? Number(input.ascend) * 12 - Number(input.descend) * 12
              : -9) * dt;
          e.vy *= Math.exp(-2 * dt);
          e.y = Math.max(0, Math.min(60, e.y + e.vy * dt));
        } else {
          if (
            e.kind === "car" &&
            e.y === 0 &&
            speed > 12 &&
            this.city.ramps.some(
              (r) => Math.abs(e.x - r.x) < 3 && Math.abs(e.z - r.z) < 3,
            )
          )
            e.vy = 9;
          e.vy -= 18 * dt;
          e.y = Math.max(0, e.y + e.vy * dt);
          if (!e.y) e.vy = 0;
        }
        if (input.brake && speed > 7)
          this.events.push({ kind: "smoke", x: e.x, z: e.z, y: e.y });
      }
      e.x += e.vx * dt;
      e.z += e.vz * dt;
      const radius =
        e.kind === "player" || e.kind === "pedestrian" ? 0.55 : 1.4;
      const hit = this.city.buildings.some(
        (b) =>
          e.y < b.h &&
          Math.abs(e.x - b.x) < b.w / 2 + radius &&
          Math.abs(e.z - b.z) < b.d / 2 + radius,
      );
      if (hit || Math.abs(e.x) > LIMIT || Math.abs(e.z) > LIMIT) {
        e.x = ox;
        e.z = oz;
        e.vx *= -0.3;
        e.vz *= -0.3;
      }
    }
    const list = [...this.entities.values()];
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i],
          b = list[j];
        if (
          a.vehicle ||
          b.vehicle ||
          a.down ||
          b.down ||
          Math.abs(a.y - b.y) > 2
        )
          continue;
        const ac = ["car", "helicopter", "plane"].includes(a.kind),
          bc = ["car", "helicopter", "plane"].includes(b.kind);
        const r = (ac ? 1.65 : 0.5) + (bc ? 1.65 : 0.5),
          dx = b.x - a.x,
          dz = b.z - a.z,
          d = Math.hypot(dx, dz);
        if (d > 0 && d < r) {
          const nx = dx / d,
            nz = dz / d,
            p = (r - d) / 2;
          a.x -= nx * p;
          a.z -= nz * p;
          b.x += nx * p;
          b.z += nz * p;
          const speed = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
          if (speed > 0) {
            a.vx -= nx * speed * 0.65;
            a.vz -= nz * speed * 0.65;
            b.vx += nx * speed * 0.65;
            b.vz += nz * speed * 0.65;
            if (speed > 6) {
              this.events.push({ kind: "hit", x: a.x, z: a.z, y: a.y });
              if (!ac) {
                a.down = 3;
                a.health = 50;
              }
              if (!bc) {
                b.down = 3;
                b.health = 50;
              }
            }
          }
        }
      }
    for (const p of this.entities.values())
      if (p.vehicle) {
        const v = this.entities.get(p.vehicle);
        if (v) {
          p.x = v.x;
          p.z = v.z;
          p.y = v.y;
          p.angle = v.angle;
        }
      }
  }
}
