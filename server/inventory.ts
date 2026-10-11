import {
  TUNING,
  WEAPONS,
  type WeaponKind,
  type WeaponItem,
} from "../shared/catalog.ts";
import type { Entity } from "../shared/world.ts";
import type { Pickup } from "../shared/protocol.ts";
export class Inventory {
  pickups = new Map<string, Pickup>();
  serial = 0;
  sources: { x: number; z: number; kind: WeaponKind; id: string; next: number }[] = [];
  addSource(x: number, z: number, kind: WeaponKind) {
    const pickup = this.spawn(x, z, this.item(kind), 0);
    pickup.expires = Number.MAX_SAFE_INTEGER;
    this.sources.push({ x, z, kind, id: pickup.id, next: 0 });
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
    const pickup: Pickup = {
      id: `p${++this.serial}`,
      x,
      z,
      y,
      item: { ...item },
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
    if (p.vehicle || p.down || p.parachute || (p.inventory?.length || 0) >= 4)
      return false;
    const found = this.nearest(p);
    if (!found) return false;
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
    if (item.ammo < spec.magazine && item.reserve > 0)
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
        const pickup = this.spawn(source.x, source.z, this.item(source.kind), time);
        pickup.expires = Number.MAX_SAFE_INTEGER;
        source.id = pickup.id;
        source.next = 0;
      }
    }
  }
}
