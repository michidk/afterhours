import { spawnOrigin } from "../../shared/world.ts";
import type { MapManifest } from "../../shared/city-stream.ts";

/** A teleport destination in the admin window; kind is free text from the city data. */
export interface AdminPlace {
  name: string;
  kind: string;
  x: number;
  z: number;
}
export interface AdminPlaceGroup {
  kind: string;
  label: string;
  places: AdminPlace[];
}

/** "townHall" / "town_hall" / "town-hall" → "Town hall". */
export function kindLabel(kind: string) {
  const words = kind
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "Other";
}

/**
 * Every landmark the city ships, plus a few fixed points that always exist. Fixed points
 * are dropped when a landmark already marks the same place, so generated airports or a
 * town hall at the centre do not appear twice.
 */
export function adminPlaces(
  map: Pick<MapManifest, "centre" | "airport">,
  landmarks: readonly { x: number; z: number; name: string; kind: string }[],
): AdminPlaceGroup[] {
  const fixed: AdminPlace[] = [
    { name: "Spawn", kind: "general", ...spawnOrigin(map) },
    ...(map.centre ? [{ name: "City centre", kind: "general", ...map.centre }] : []),
    { name: "Airport", kind: "general", x: map.airport.x, z: map.airport.z },
  ].filter(
    (point) =>
      !landmarks.some(
        (landmark) => Math.hypot(landmark.x - point.x, landmark.z - point.z) < 30,
      ),
  );
  const groups = new Map<string, AdminPlace[]>();
  for (const place of [...fixed, ...landmarks]) {
    const kind = String(place.kind || "other");
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind)!.push({ name: place.name, kind, x: place.x, z: place.z });
  }
  return [...groups]
    .map(([kind, places]) => ({
      kind,
      label: kind === "general" ? "General" : kindLabel(kind),
      places: places.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) =>
      a.kind === "general"
        ? -1
        : b.kind === "general"
          ? 1
          : a.label.localeCompare(b.label),
    );
}
