import { WEAPONS, TUNING } from "../shared/catalog.ts";
import type { Entity, Input, City, WorldEvent } from "../shared/world.ts";
import {
  clamp,
  vehicle,
  rayDistance,
  entityBox,
  buildingBox,
} from "../shared/physics/index.ts";
import type { Inventory } from "./inventory.ts";
import type { Destruction } from "./destruction.ts";
import type { Vec3 } from "../shared/destruction.ts";
interface CombatWorld {
  time: number;
  city: City;
  entities: Map<string, Entity>;
  inputs: Map<string, Input>;
  inventory: Inventory;
  events: WorldEvent[];
  damage: (e: Entity, amount: number) => void;
  destruction: Destruction;
  damageProp: (id: string, amount: number, velocity: Vec3) => boolean;
}
export class Combat {
  private history: {
    time: number;
    entities: Map<string, { x: number; z: number; y: number; angle: number }>;
  }[] = [];
  attack(p: Entity, sim: CombatWorld) {
    if ((p.cooldown || 0) > 0 || p.vehicle || p.down || p.parachute || p.reloadUntil)
      return;
    const item = sim.inventory.equipped(p),
      spec = WEAPONS[item?.kind || "fists"];
    if (spec.magazine && item) {
      if (item.ammo <= 0) {
        sim.inventory.reload(p, sim.time);
        if (!p.reloadUntil) {
          p.cooldown = spec.cooldown;
          sim.events.push({
            kind: "dryFire",
            sound: "dryFire",
            x: p.x,
            y: p.y + 1,
            z: p.z,
          });
        }
        return;
      }
      item.ammo--;
    }
    p.cooldown = spec.cooldown;
    const dx = Math.sin(p.angle),
      dz = Math.cos(p.angle),
      range = spec.range;
    const wallDistance = (x: number, z: number) =>
      Math.min(
        range,
        ...sim.city.buildings
          .filter((b) => b.h + 1.8 > p.y + 1)
          .map((b) => rayDistance(p.x, p.z, x, z, buildingBox(b), range)),
      );
    const wall = wallDistance(dx, dz);
    const rewind = spec.magazine
      ? this.history.find(
          (h) =>
            h.time >=
            clamp(
              sim.inputs.get(p.id)?.shotTime ?? sim.time,
              sim.time - TUNING.lagCompensation,
              sim.time,
            ),
        )
      : undefined;
    const hits = [...sim.entities.values()]
      .filter((e) => e.id !== p.id && !e.vehicle && !e.wreck)
      .map((e) => {
        const pose = rewind?.entities.get(e.id) || e,
          tx = pose.x - p.x,
          tz = pose.z - p.z,
          d = Math.hypot(tx, tz);
        if (Math.abs(pose.y - p.y) > 2) return { e, distance: Infinity };
        const distance = spec.magazine
          ? rayDistance(p.x, p.z, dx, dz, entityBox({ ...e, ...pose }), range)
          : d > 0 && (tx * dx + tz * dz) / d > 0.75 && wallDistance(tx / d, tz / d) > d
            ? d
            : Infinity;
        return { e, distance };
      })
      .filter((h) => h.distance < range && (!spec.magazine || h.distance < wall))
      .sort((a, b) => a.distance - b.distance);
    const prop = sim.destruction.ray(p.x, p.z, p.y + 1, dx, dz, range),
      propHit =
        prop && prop.distance < wall && prop.distance < (hits[0]?.distance ?? range)
          ? prop
          : undefined,
      hit = propHit ? undefined : hits[0],
      length = spec.magazine
        ? Math.min(wall, propHit?.distance ?? hit?.distance ?? range)
        : 0;
    sim.events.push({
      kind: spec.magazine ? "shot" : "swing",
      sound: item?.kind === "smg" ? "smg" : spec.magazine ? "pistol" : "swing",
      x: p.x,
      z: p.z,
      y: p.y + 1,
      angle: p.angle,
      length,
    });
    if (propHit) {
      sim.damageProp(propHit.prop.id, spec.damage, { x: dx * 4, y: 1, z: dz * 4 });
      sim.events.push({
        kind: "hit",
        sound:
          propHit.prop.kind === "palm" ||
          propHit.prop.kind === "tree" ||
          propHit.prop.kind === "bench"
            ? "impactWood"
            : "impact",
        x: propHit.prop.x,
        y: p.y + 1,
        z: propHit.prop.z,
      });
    }
    if (hit) {
      sim.damage(hit.e, spec.damage);
      const push = vehicle(hit.e) ? 0.3 : 4;
      hit.e.vx += dx * push;
      hit.e.vz += dz * push;
      sim.events.push({
        kind: "hit",
        sound: vehicle(hit.e)
          ? "impact"
          : spec.magazine
            ? "impactBody"
            : item?.kind === "bat"
              ? "bat"
              : "punch",
        x: p.x + dx * hit.distance,
        z: p.z + dz * hit.distance,
        y: p.y + 1,
      });
    }
  }
  record(sim: CombatWorld) {
    this.history.push({
      time: sim.time,
      entities: new Map(
        [...sim.entities.values()].map((e) => [
          e.id,
          { x: e.x, z: e.z, y: e.y, angle: e.angle },
        ]),
      ),
    });
    this.history = this.history.filter(
      (h) => h.time >= sim.time - TUNING.lagCompensation - 0.05,
    );
  }
}
