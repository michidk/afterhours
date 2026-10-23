import type { Entity } from "../../shared/world.ts";

/** Why the player is no longer in the vehicle they were in. */
export interface SeatLoss {
  at: number;
  vehicle: string;
  reason: string;
}

/**
 * Notices when the vehicle the player sits in disappears or they are dropped out of it without
 * pressing the enter/exit key (`pressedAt` is when they last did, in the caller's clock). A car
 * once vanished under an idle player; this says on the Networking panel whether the server
 * removed it, wrecked it, or just stopped listing the player as its rider.
 */
export class SeatWatch {
  loss: SeatLoss | undefined;
  private vehicle: string | undefined;
  /** Newest server state of the vehicle, to tell a wreck from a removal after the fact. */
  private last: Entity | undefined;
  update(
    now: number,
    playerId: string,
    entities: ReadonlyMap<string, Entity>,
    pressedAt = -Infinity,
  ) {
    const rider = entities.get(playerId)?.vehicle;
    const car = this.vehicle ? entities.get(this.vehicle) : undefined;
    if (this.vehicle && rider !== this.vehicle && now - pressedAt > 1500) {
      const why = !car
        ? "the server removed the vehicle"
        : car.wreck !== undefined
          ? "the vehicle was wrecked"
          : car.health <= 0
            ? "the vehicle burned out"
            : "the server seated you elsewhere or on foot";
      this.loss = { at: now, vehicle: this.vehicle, reason: why };
      console.warn(`Left vehicle ${this.vehicle}: ${why}`, this.last);
    }
    if (rider !== this.vehicle) this.vehicle = rider;
    this.last = rider ? entities.get(rider) : undefined;
  }
}
