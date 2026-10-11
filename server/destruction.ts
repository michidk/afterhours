import RAPIER from "@dimforge/rapier3d-compat";
import {
  destructibles,
  setBrokenProps,
  type Destructible,
  type DebrisState,
  type Vec3,
} from "../shared/destruction.ts";
import type { City, Entity } from "../shared/world.ts";
import { TUNING } from "../shared/catalog.ts";
import { SpatialGrid } from "../shared/spatial.ts";
import { staticGeometry } from "../shared/physics/static.ts";
import { shape, rayDistance } from "../shared/physics/collision.ts";

await RAPIER.init();
const health = { palm: 65, tree: 90, lamp: 45, bench: 40, signal: 50, hydrant: 45 };
const weight = {
  palm: 100,
  tree: 180,
  lamp: 35,
  bench: 35,
  signal: 40,
  hydrant: 30,
  corpse: 80,
};
type Body = { state: DebrisState; body: RAPIER.RigidBody };

/** Temporary destruction overlay. The saved City and its map identity never change. */
export class Destruction {
  readonly fixtures: Map<string, Destructible>;
  readonly active = new Map<string, Body>();
  readonly broken = new Set<string>();
  readonly maxBodies = 128;
  private grid = new SpatialGrid<Destructible>(32);
  private damageTaken = new Map<string, number>();
  private physics?: RAPIER.World;
  private fixed = new Map<string, RAPIER.Collider>();
  private proxies = new Map<string, RAPIER.RigidBody>();
  private serial = 0;
  constructor(readonly city: City) {
    this.fixtures = new Map(destructibles(city).map((p) => [p.id, p]));
    for (const p of this.fixtures.values())
      this.grid.insert(p, p.x, p.z, Math.max(p.w, p.d));
  }
  private world() {
    if (!this.physics) {
      this.physics = new RAPIER.World({ x: 0, y: -18, z: 0 });
      this.physics.createCollider(
        RAPIER.ColliderDesc.cuboid(4096, 0.1, 4096)
          .setTranslation(0, 0, 0)
          .setFriction(0.85),
      );
      for (const p of this.city.parks)
        this.physics.createCollider(
          RAPIER.ColliderDesc.cuboid((p.w ?? 38) / 2, 0.2, (p.d ?? 38) / 2)
            .setTranslation(p.x, 0.2, p.z)
            .setFriction(0.85),
        );
    }
    return this.physics;
  }
  private spawn(
    source: DebrisState["source"],
    time: number,
    velocity: Vec3,
    seconds: number,
  ) {
    if (this.active.size >= this.maxBodies) return false;
    const world = this.world(),
      h = source.h,
      corpse = source.kind === "corpse";
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setRotation({
          x: 0,
          y: Math.sin((source.kind === "corpse" ? 0 : (source.angle ?? 0)) / 2),
          z: 0,
          w: Math.cos((source.kind === "corpse" ? 0 : (source.angle ?? 0)) / 2),
        })
        .setTranslation(source.x, h / 2 + 0.16, source.z)
        .setLinvel(velocity.x, velocity.y, velocity.z)
        .setAngvel({
          x: velocity.z * 0.3 + (corpse ? 2 : 0.7),
          y: 0.3,
          z: -velocity.x * 0.3 - 0.8,
        })
        .setLinearDamping(0.6)
        .setAngularDamping(0.8)
        .setCcdEnabled(true),
    );
    const collider = corpse
      ? RAPIER.ColliderDesc.capsule(h / 2 - 0.3, 0.3)
      : RAPIER.ColliderDesc.cuboid(source.w / 2, h / 2, source.d / 2);
    world.createCollider(
      collider.setMass(weight[source.kind]).setRestitution(0.15).setFriction(0.8),
      body,
    );
    const state: DebrisState = {
      id: source.id,
      source,
      position: { ...body.translation() },
      rotation: { ...body.rotation() },
      velocity: { ...body.linvel() },
      angularVelocity: { ...body.angvel() },
      brokenAt: time,
      expiresAt: time + seconds,
    };
    this.active.set(source.id, { state, body });
    return true;
  }
  hit(id: string, amount: number, time: number, velocity: Vec3) {
    const p = this.fixtures.get(id);
    if (!p || this.broken.has(id) || !Number.isFinite(amount) || amount <= 0)
      return false;
    const damage = (this.damageTaken.get(id) ?? 0) + amount;
    this.damageTaken.set(id, damage);
    if (
      damage < health[p.kind] ||
      !this.spawn(p, time, velocity, TUNING.propDebrisSeconds)
    )
      return false;
    this.broken.add(id);
    this.damageTaken.delete(id);
    const fixed = this.fixed.get(id);
    if (fixed) {
      this.physics!.removeCollider(fixed, true);
      this.fixed.delete(id);
    }
    setBrokenProps(this.city, this.broken);
    return true;
  }
  corpse(e: Entity, time: number) {
    const id = `body:${e.id}:${++this.serial}`;
    this.spawn(
      { id, kind: "corpse", x: e.x, z: e.z, h: 1.9, w: 0.65, d: 0.6, color: e.color },
      time,
      { x: e.vx, y: Math.max(0, e.vy), z: e.vz },
      TUNING.corpseSeconds,
    );
    const entry = this.active.get(id);
    if (entry) entry.body.setTranslation({ x: e.x, y: e.y + 1, z: e.z }, true);
  }
  ray(x: number, z: number, y: number, dx: number, dz: number, range: number) {
    return this.grid
      .query(x + (dx * range) / 2, z + (dz * range) / 2, range / 2 + 6)
      .filter((p) => !this.broken.has(p.id) && y >= 0 && y < p.h + 0.3)
      .map((p) => ({
        prop: p,
        distance: rayDistance(
          x,
          z,
          dx,
          dz,
          { x: p.x, z: p.z, w: p.w / 2, d: p.d / 2, angle: 0 },
          range,
        ),
      }))
      .filter((p) => p.distance <= range)
      .sort((a, b) => a.distance - b.distance)[0];
  }
  blast(x: number, y: number, z: number, time: number) {
    for (const p of this.grid.query(x, z, TUNING.explosionRadius)) {
      const dx = p.x - x,
        dz = p.z - z,
        d = Math.hypot(dx, dz, y);
      if (d >= TUNING.explosionRadius) continue;
      this.hit(p.id, (1 - d / TUNING.explosionRadius) * 150, time, {
        x: (dx / (d || 1)) * 9,
        y: 4,
        z: (dz / (d || 1)) * 9,
      });
    }
    for (const { body } of this.active.values()) {
      const p = body.translation(),
        dx = p.x - x,
        dz = p.z - z,
        d = Math.hypot(dx, p.y - y, dz);
      if (d < TUNING.explosionRadius)
        body.applyImpulse(
          { x: (dx / (d || 1)) * 200, y: 150, z: (dz / (d || 1)) * 200 },
          true,
        );
    }
  }
  update(time: number, dt: number, entities: Entity[]) {
    if (!this.physics) return;
    const world = this.physics;
    for (const [id, entry] of this.active) {
      if (time < entry.state.expiresAt) continue;
      // Wait, faded out, if an actor is occupying a fixture's reset position.
      const p = entry.state.source;
      if (
        p.kind !== "corpse" &&
        entities.some(
          (e) =>
            !e.vehicle &&
            e.health > 0 &&
            e.y < p.h &&
            Math.hypot(e.x - p.x, e.z - p.z) <
              Math.max(p.w, p.d) / 2 + Math.max(shape(e).w, shape(e).d),
        )
      )
        continue;
      world.removeRigidBody(entry.body);
      this.active.delete(id);
      this.broken.delete(id);
    }
    setBrokenProps(this.city, this.broken);
    if (!this.active.size) {
      world.free();
      this.physics = undefined;
      this.fixed.clear();
      this.proxies.clear();
      return;
    }
    // Only nearby fixed geometry and actors enter the debris world. Vehicles retain their established driving solver.
    const nearby = new Set<string>();
    for (const { body, state } of this.active.values()) {
      const pos = body.translation();
      for (const b of staticGeometry(this.city).query(
        pos.x,
        pos.z,
        16 + state.source.h,
      )) {
        const id = b.destructibleId ?? `building:${b.x},${b.z}`;
        if (this.fixed.has(id) || this.broken.has(id)) continue;
        const height = b.h + (b.obstacle ? 0 : 1.8);
        this.fixed.set(
          id,
          world.createCollider(
            RAPIER.ColliderDesc.cuboid(b.w / 2, height / 2, b.d / 2)
              .setTranslation(b.x, height / 2, b.z)
              .setFriction(0.8),
          ),
        );
      }
      for (const e of entities) {
        if (
          e.vehicle ||
          e.health <= 0 ||
          Math.hypot(e.x - pos.x, e.z - pos.z) > 18 + state.source.h
        )
          continue;
        nearby.add(e.id);
        let proxy = this.proxies.get(e.id);
        const s = shape(e),
          height = 1.8;
        if (!proxy) {
          proxy = world.createRigidBody(
            RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
              e.x,
              e.y + height / 2 + 0.1,
              e.z,
            ),
          );
          world.createCollider(RAPIER.ColliderDesc.cuboid(s.w, height / 2, s.d), proxy);
          this.proxies.set(e.id, proxy);
        }
        proxy.setNextKinematicTranslation({
          x: e.x,
          y: e.y + height / 2 + 0.1,
          z: e.z,
        });
        proxy.setNextKinematicRotation({
          x: 0,
          y: Math.sin(e.angle / 2),
          z: 0,
          w: Math.cos(e.angle / 2),
        });
      }
    }
    for (const [id, body] of this.proxies)
      if (!nearby.has(id)) {
        world.removeRigidBody(body);
        this.proxies.delete(id);
      }
    world.timestep = dt;
    world.step();
    for (const entry of this.active.values()) {
      entry.state.position = { ...entry.body.translation() };
      entry.state.rotation = { ...entry.body.rotation() };
      entry.state.velocity = { ...entry.body.linvel() };
      entry.state.angularVelocity = { ...entry.body.angvel() };
    }
  }
  snapshot(center: { x: number; z: number }, radius: number) {
    return [...this.active.values()]
      .map((entry) => entry.state)
      .filter(
        (s) =>
          Math.min(
            Math.hypot(s.position.x - center.x, s.position.z - center.z),
            Math.hypot(s.source.x - center.x, s.source.z - center.z),
          ) <
          radius + s.source.h,
      );
  }
  dispose() {
    this.physics?.free();
    this.physics = undefined;
    this.active.clear();
    this.broken.clear();
    this.fixed.clear();
    this.proxies.clear();
    setBrokenProps(this.city, []);
  }
}
