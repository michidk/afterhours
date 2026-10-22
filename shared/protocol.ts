import type { WeaponItem, AmmoKind } from "./catalog.ts";

export interface PlayerSummary {
  id: string;
  name: string;
  color: string;
}
/** Where every joined player is, regardless of network interest; drives the island map. */
export interface PlayerPosition {
  id: string;
  x: number;
  z: number;
  angle: number;
}
export type PickupPayload =
  | { kind: "weapon"; item: WeaponItem }
  | { kind: "ammo"; ammoKind: AmmoKind; amount: number }
  | { kind: "jetpack"; fuel: number };
export type Pickup = PickupPayload & {
  id: string;
  x: number;
  z: number;
  y: number;
  expires: number;
};
