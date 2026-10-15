import { WEAPONS, type WeaponItem } from "../../shared/catalog.ts";

/** One cell per equip key (1-4): the active weapon lit, ranged weapons with magazine / reserve. */
export function loadoutHTML(
  inventory: WeaponItem[] = [],
  equipped = 0,
  reloading = false,
) {
  return Array.from({ length: 4 }, (_, i) => {
    const item = inventory[i];
    if (!item) return `<div class="slot none"><kbd>${i + 1}</kbd></div>`;
    const weapon = WEAPONS[item.kind];
    const ammo =
      weapon.magazine > 0
        ? `<b>${item.ammo}</b><small>/ ${item.reserve}</small>`
        : "<small>melee</small>";
    const state = [
      i === equipped && "active",
      i === equipped && reloading && "reloading",
      weapon.magazine > 0 && item.ammo + item.reserve === 0 && "dry",
    ]
      .filter(Boolean)
      .join(" ");
    return `<div class="slot ${state}"><kbd>${i + 1}</kbd><span>${weapon.name}</span><div>${ammo}</div></div>`;
  }).join("");
}
