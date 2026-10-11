import { VEHICLES } from "./catalog.ts";
import type { Entity } from "./world.ts";

export function seatCapacity(vehicle: Entity) {
  const model =
    vehicle.model ||
    (vehicle.kind === "helicopter"
      ? "scout"
      : vehicle.kind === "plane"
        ? "plane"
        : "sedan");
  return VEHICLES[model].seatCount;
}

export function vehicleSeats(vehicle: Entity): (string | null)[] {
  return Array.from({ length: seatCapacity(vehicle) }, (_, index) =>
    index === 0 ? vehicle.driver || null : vehicle.seats?.[index] || null,
  );
}

export function availableSeat(vehicle: Entity) {
  return vehicleSeats(vehicle).findIndex((occupant) => occupant === null);
}

export function occupiedSeats(vehicle: Entity) {
  return vehicleSeats(vehicle).filter((occupant) => occupant !== null).length;
}
