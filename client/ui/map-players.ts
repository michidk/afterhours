import type { PlayerPosition, PlayerSummary } from "../../shared/protocol.ts";
import type { Entity } from "../../shared/world.ts";

export interface MapPlayer extends PlayerSummary {
  x: number;
  z: number;
  angle: number;
  self: boolean;
}

/**
 * Everyone on the roster with a place on the map. Players inside network interest use
 * their live entity (or their vehicle); the rest use the last twice-a-second position.
 */
export function mapPlayers(
  roster: PlayerSummary[],
  entities: Entity[],
  far: Map<string, PlayerPosition>,
  self?: string,
): MapPlayer[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const players: MapPlayer[] = [];
  for (const p of roster) {
    const actor = byId.get(p.id),
      body = (actor?.vehicle && byId.get(actor.vehicle)) || actor || far.get(p.id);
    if (body)
      players.push({
        ...p,
        x: body.x,
        z: body.z,
        angle: body.angle,
        self: p.id === self,
      });
  }
  // The player themselves first, then by name, so the list order is stable.
  return players.sort(
    (a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name),
  );
}

/** Player colours come from the join message; only a plain hex colour reaches CSS or canvas. */
export const swatch = (color: string) =>
  /^#[0-9a-f]{3,8}$/i.test(color) ? color : "#7dcada";
