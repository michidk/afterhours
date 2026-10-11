import type { CityScene } from "../scene.ts";
import type { Road } from "../../shared/world.ts";

/** Render exactly one persisted segment; streaming owns its stable feature ID. */
export function buildRoad(host: CityScene, road: Road) {
  const dx = road.bx - road.ax,
    dz = road.bz - road.az,
    length = Math.hypot(dx, dz),
    angle = Math.atan2(dx, dz);
  const nx = dz / length,
    nz = -dx / length;
  const strip = (
    name: string,
    offset: number,
    along: number,
    y: number,
    w: number,
    h: number,
    d: number,
    color: string,
  ) => {
    const mesh = host.box(
      name,
      road.x + nx * offset + (dx / length) * along,
      y,
      road.z + nz * offset + (dz / length) * along,
      w,
      h,
      d,
      color,
    );
    mesh.rotation.y = angle;
    return mesh;
  };
  // Flat overlapping aprons hide seams between sampled curve segments.
  strip("street apron", 0, 0, 0.015, road.width + 8, 0.03, length + 0.1, "#c9c2ac");
  strip("asphalt", 0, 0, 0.055, road.width, 0.035, length + 0.1, "#555b5c");
  for (const end of [-1, 1]) {
    const x = end < 0 ? road.ax : road.bx,
      z = end < 0 ? road.az : road.bz;
    const apron = host.cylinder(
      "street apron join",
      x,
      0.011,
      z,
      0.03,
      road.width + 8,
      "#c9c2ac",
    );
    const asphalt = host.cylinder(
      "street join",
      x,
      0.051,
      z,
      0.035,
      road.width,
      "#555b5c",
    );
    // Join caps receive the same shading as pavement, without casting
    // near-coplanar shadows back onto the adjoining road strips.
    for (const mesh of [apron, asphalt]) {
      host.shadows.removeShadowCaster(mesh);
      mesh.receiveShadows = true;
    }
  }
  for (let t = 8; t < length - 8; t += 9)
    strip("lane dash", 0, t - length / 2, 0.085, 0.14, 0.015, 3, "#e0d9bd");
  for (const [end, controlled] of [
    [-1, road.signalA],
    [1, road.signalB],
  ] as const) {
    if (!controlled || length < 15) continue;
    const along = end * (length / 2 - 9);
    for (let offset = -road.width / 2 + 1; offset < road.width / 2; offset += 2)
      strip("crosswalk", offset, along, 0.09, 1, 0.015, 2.5, "#dfdbc8");
  }
}
