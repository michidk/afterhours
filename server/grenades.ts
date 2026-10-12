import { type City, type Entity } from "../shared/world.ts";
import { WORLD_LIMIT, groundLevel } from "../shared/water.ts";
import type { GrenadeState } from "../shared/grenades.ts";
import { staticGeometry } from "../shared/physics/static.ts";
import { WEAPONS } from "../shared/catalog.ts";
import { contact, entityBox } from "../shared/physics/collision.ts";

const FUSE_SECONDS = 3,
  OWNER_GRACE_SECONDS = 0.2;

export class Grenades {
  readonly active = new Map<string, GrenadeState>();
  readonly maxActive = 96;
  private serial = 0;
  throw(p: Entity, time: number) {
    if (this.active.size >= this.maxActive) return false;
    const aim = p.aim ?? p.angle,
      dx = Math.sin(aim),
      dz = Math.cos(aim);
    const g: GrenadeState = {
      id: `grenade:${++this.serial}`,
      owner: p.id,
      x: p.x,
      y: p.y + 1.2,
      z: p.z,
      vx: dx * 15 + p.vx,
      vy: 7 + Math.max(0, p.vy),
      vz: dz * 15 + p.vz,
      radius: 0.16,
      detonateAt: time + FUSE_SECONDS,
    };
    this.active.set(g.id, g);
    return true;
  }
  step(
    city: City,
    time: number,
    dt: number,
    blast: (x: number, y: number, z: number, radius: number, damage: number) => void,
    entities: Iterable<Entity> = [],
  ) {
    if (!this.active.size) return;
    const colliders = [...entities].filter(
      (e) =>
        !e.vehicle &&
        ((e.kind !== "player" && e.kind !== "pedestrian") || e.health > 0),
    );
    for (const g of this.active.values()) {
      if (time >= g.detonateAt) {
        this.active.delete(g.id);
        blast(g.x, g.y, g.z, WEAPONS.grenade.range, WEAPONS.grenade.damage);
        continue;
      }
      const previousY = g.y;
      g.vy -= 18 * dt;
      g.x += g.vx * dt;
      g.y += g.vy * dt;
      g.z += g.vz * dt;
      for (const b of staticGeometry(city).query(g.x, g.z, 2)) {
        const w = b.w / 2 + g.radius,
          d = b.d / 2 + g.radius;
        const dx = g.x - b.x,
          dz = g.z - b.z;
        const top = b.obstacle ? b.h : b.h + 1.8;
        if (Math.abs(dx) >= w || Math.abs(dz) >= d || g.y - g.radius >= top) continue;
        if (previousY - g.radius >= top && g.vy < 0) {
          g.y = top + g.radius;
          g.vy *= -0.4;
          g.vx *= 0.7;
          g.vz *= 0.7;
        } else if (w - Math.abs(dx) < d - Math.abs(dz)) {
          g.x = b.x + (dx < 0 ? -w : w);
          g.vx *= -0.5;
        } else {
          g.z = b.z + (dz < 0 ? -d : d);
          g.vz *= -0.5;
        }
      }
      for (const e of colliders) {
        if (
          e.id === g.owner &&
          time < g.detonateAt - FUSE_SECONDS + OWNER_GRACE_SECONDS
        )
          continue;
        const box = entityBox(e);
        if (
          Math.abs(g.x - e.x) > box.w + box.d + g.radius ||
          Math.abs(g.z - e.z) > box.w + box.d + g.radius
        )
          continue;
        const top = e.y + 1.8;
        if (g.y - g.radius >= top || g.y + g.radius <= e.y) continue;
        const collision = contact(
          { x: g.x, z: g.z, angle: 0, w: g.radius, d: g.radius },
          box,
        );
        if (!collision) continue;
        if (previousY - g.radius >= top && g.vy < e.vy) {
          g.y = top + g.radius;
          g.vy = e.vy + (e.vy - g.vy) * 0.4;
          g.vx *= 0.7;
          g.vz *= 0.7;
        } else if (previousY + g.radius <= e.y && g.vy > e.vy) {
          g.y = e.y - g.radius;
          g.vy = e.vy - (g.vy - e.vy) * 0.4;
        } else {
          g.x -= collision.nx * collision.depth;
          g.z -= collision.nz * collision.depth;
          const speed = (g.vx - e.vx) * collision.nx + (g.vz - e.vz) * collision.nz;
          if (speed > 0) {
            g.vx -= collision.nx * speed * 1.5;
            g.vz -= collision.nz * speed * 1.5;
          }
        }
      }
      const floor = groundLevel(g.x, g.z, city) + g.radius;
      if (g.y < floor) {
        g.y = floor;
        g.vy = Math.abs(g.vy) > 0.5 ? Math.abs(g.vy) * 0.4 : 0;
        const friction = Math.exp(-4 * dt);
        g.vx *= friction;
        g.vz *= friction;
      }
      for (const axis of ["x", "z"] as const)
        if (Math.abs(g[axis]) > WORLD_LIMIT - g.radius) {
          g[axis] = Math.sign(g[axis]) * (WORLD_LIMIT - g.radius);
          if (axis === "x") g.vx *= -0.5;
          else g.vz *= -0.5;
        }
    }
  }
  snapshot(x: number, z: number, radius: number) {
    return [...this.active.values()]
      .filter((g) => Math.hypot(g.x - x, g.z - z) < radius)
      .map((g) => ({ ...g }));
  }
}
