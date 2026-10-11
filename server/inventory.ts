import {
  TUNING,
  WEAPONS,
  type WeaponKind,
  type WeaponItem,
  type AmmoKind,
} from "../shared/catalog.ts";
import type { Entity } from "../shared/world.ts";
import type { Pickup, PickupPayload } from "../shared/protocol.ts";
export class Inventory {
  pickups = new Map<string, Pickup>();
  serial = 0;
  sources: {
    x: number;
    z: number;
    payload: PickupPayload;
    id: string;
    next: number;
  }[] = [];
  addSource(x: number, z: number, kind: WeaponKind) {
    this.addSupplySource(x, z, { kind: "weapon", item: this.item(kind) });
  }
  addSupplySource(x: number, z: number, payload: PickupPayload) {
    const pickup = this.spawnPayload(x, z, payload, 0);
    pickup.expires = Number.MAX_SAFE_INTEGER;
    this.sources.push({ x, z, payload, id: pickup.id, next: 0 });
  }
  item(kind: WeaponKind): WeaponItem {
    const spec = WEAPONS[kind];
    return {
      id: `w${++this.serial}`,
      kind,
      ammo: spec.magazine,
      reserve: spec.reserve,
    };
  }
  initialize(p: Entity) {
    p.inventory = [this.item("fists")];
    p.equipped = 0;
    p.weapon = "fists";
    p.jetpack = undefined;
    p.reloadUntil = undefined;
  }
  equipped(p: Entity) {
    return p.inventory?.[p.equipped || 0];
  }
  give(p: Entity, kind: WeaponKind) {
    p.inventory ??= [];
    if (p.inventory.length >= 4) return false;
    p.inventory.push(this.item(kind));
    this.equip(p, p.inventory.length - 1);
    return true;
  }
  equip(p: Entity, slot: number) {
    if (!p.inventory?.[slot] || p.vehicle || p.down) return;
    p.equipped = slot;
    p.weapon = p.inventory[slot].kind;
    p.reloadUntil = undefined;
  }
  drop(p: Entity, time: number) {
    if (p.jetpack?.active && !p.vehicle && !p.down) {
      this.spawnJetpack(p.x, p.z, p.jetpack.fuel, time, p.y);
      p.jetpack = undefined;
      return;
    }
    const item = this.equipped(p);
    if (!item || item.kind === "fists" || p.vehicle || p.down || p.parachute) return;
    this.spawn(
      p.x + Math.sin(p.angle) * 0.8,
      p.z + Math.cos(p.angle) * 0.8,
      item,
      time,
      p.y,
    );
    p.inventory!.splice(p.equipped || 0, 1);
    this.equip(p, 0);
  }
  spawn(x: number, z: number, item: WeaponItem, time: number, y = 0) {
    return this.spawnPayload(x, z, { kind: "weapon", item: { ...item } }, time, y);
  }
  spawnAmmo(
    x: number,
    z: number,
    ammoKind: AmmoKind,
    amount: number,
    time: number,
    y = 0,
  ) {
    return this.spawnPayload(x, z, { kind: "ammo", ammoKind, amount }, time, y);
  }
  spawnJetpack(x: number, z: number, fuel: number, time: number, y = 0) {
    return this.spawnPayload(x, z, { kind: "jetpack", fuel }, time, y);
  }
  private spawnPayload(
    x: number,
    z: number,
    payload: PickupPayload,
    time: number,
    y = 0,
  ) {
    const pickup: Pickup = {
      ...payload,
      id: `p${++this.serial}`,
      x,
      z,
      y,
      expires: time + TUNING.pickupSeconds,
    };
    this.pickups.set(pickup.id, pickup);
    return pickup;
  }
  nearest(p: Entity) {
    return [...this.pickups.values()]
      .filter(
        (e) => Math.abs(e.y - p.y) < 1.2 && Math.hypot(e.x - p.x, e.z - p.z) < 2.5,
      )
      .sort(
        (a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z),
      )[0];
  }
  pickup(p: Entity, time: number) {
    if (p.vehicle || p.down || p.parachute) return false;
    const found = this.nearest(p);
    if (!found) return false;
    if (found.kind === "ammo") {
      const before = found.amount;
      for (const item of p.inventory || []) {
        const spec = WEAPONS[item.kind];
        if (spec.ammoKind !== found.ammoKind) continue;
        const field = spec.mode === "throw" ? "ammo" : "reserve";
        const cap = spec.mode === "throw" ? spec.magazine : spec.reserve;
        const amount = Math.min(found.amount, cap - item[field]);
        item[field] += amount;
        found.amount -= amount;
      }
      if (!found.amount) this.pickups.delete(found.id);
      return found.amount < before;
    }
    if (found.kind === "jetpack") {
      if (p.jetpack) return false;
      p.jetpack = { fuel: found.fuel, active: false };
      this.pickups.delete(found.id);
      return true;
    }
    if ((p.inventory?.length || 0) >= 4) return false;
    this.pickups.delete(found.id);
    p.inventory ??= [];
    p.inventory.push(found.item);
    this.equip(p, p.inventory.length - 1);
    return true;
  }
  reload(p: Entity, time: number) {
    const item = this.equipped(p);
    if (!item || p.vehicle || p.down || p.reloadUntil) return;
    const spec = WEAPONS[item.kind];
    if (spec.mode !== "throw" && item.ammo < spec.magazine && item.reserve > 0)
      p.reloadUntil = time + spec.reload;
  }
  tick(p: Entity, time: number) {
    if (p.reloadUntil && time >= p.reloadUntil) {
      const item = this.equipped(p);
      if (item) {
        const needed = Math.min(WEAPONS[item.kind].magazine - item.ammo, item.reserve);
        item.ammo += needed;
        item.reserve -= needed;
      }
      p.reloadUntil = undefined;
    }
  }
  cleanup(time: number) {
    for (const [id, p] of this.pickups) if (p.expires < time) this.pickups.delete(id);
    for (const source of this.sources) {
      if (this.pickups.has(source.id)) continue;
      if (!source.next) {
        source.next = time + 20;
        continue;
      }
      if (time >= source.next) {
        const payload =
          source.payload.kind === "weapon"
            ? { kind: "weapon" as const, item: this.item(source.payload.item.kind) }
            : source.payload;
        const pickup = this.spawnPayload(source.x, source.z, payload, time);
        pickup.expires = Number.MAX_SAFE_INTEGER;
        source.id = pickup.id;
        source.next = 0;
      }
    }
  }
}
