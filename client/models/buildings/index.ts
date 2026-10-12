import type { CityScene } from "../../scene.ts";
import type { Building } from "../../../shared/world.ts";
import { BUILDING_ASSETS } from "../../../shared/assets/buildings/index.ts";

/** Placeholder asset adapter. Replace here with authored meshes while preserving bounds. */
export function buildBuilding(
  scene: CityScene,
  b: Building,
  index: number,
  random: () => number,
) {
  const asset = BUILDING_ASSETS[b.asset ?? "shop-house"];
  const facing = b.facing ?? 0,
    angle = (facing * Math.PI) / 2 + (b.angle ?? 0),
    // Generated cities place pads on terrain: walls span the pad altitude to the roof.
    base = b.y ?? 0,
    height = b.h - base;
  const w = facing % 2 ? b.d : b.w,
    d = facing % 2 ? b.w : b.d;
  const box = (
    name: string,
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    depth: number,
    color: string,
    shadow = false,
  ) => {
    const mesh = scene.box(
      name,
      b.x + x * Math.cos(angle) - z * Math.sin(angle),
      base + y,
      b.z + x * Math.sin(angle) + z * Math.cos(angle),
      width,
      height,
      depth,
      color,
      undefined,
      shadow,
    );
    mesh.rotation.y = -angle;
    return mesh;
  };
  box(asset.name, 0, (height - 0.05) / 2, 0, w, height - 0.05, d, b.color, true);
  if (b.asset === "container") {
    for (let x = -w / 2 + 0.5; x < w / 2; x += 0.8)
      for (const side of [-1, 1])
        box(
          "cargo rib",
          x,
          height / 2,
          side * (d / 2 + 0.025),
          0.08,
          height - 0.15,
          0.06,
          asset.trim,
        );
    return;
  }
  box("foundation", 0, 0.4, 0, w + 0.12, 0.8, d + 0.12, asset.trim);
  // Flat roof detailing stays within the server's roof height (no invisible rooftop obstacles).
  box("roof deck", 0, height - 0.0125, 0, w - 0.5, 0.025, d - 0.5, "#89938b");
  for (const side of [-1, 1]) {
    box(
      "roof coping",
      0,
      height - 0.15,
      side * (d / 2 - 0.15),
      w,
      0.3,
      0.3,
      asset.trim,
    );
    box(
      "roof coping",
      side * (w / 2 - 0.15),
      height - 0.15,
      0,
      0.3,
      0.3,
      d,
      asset.trim,
    );
  }
  // Four finished faces: repeated window strips keep distant silhouettes clean and batch well.
  for (let face = 0; face < 4; face++) {
    const span = face % 2 ? d : w,
      depth = face % 2 ? w : d;
    const surface = (
      name: string,
      u: number,
      y: number,
      width: number,
      height: number,
      thickness: number,
      color: string,
    ) => {
      const sign = face < 2 ? -1 : 1;
      return face % 2
        ? box(
            name,
            sign * (depth / 2 + thickness / 2),
            y,
            u,
            thickness,
            height,
            width,
            color,
          )
        : box(
            name,
            u,
            y,
            sign * (depth / 2 + thickness / 2),
            width,
            height,
            thickness,
            color,
          );
    };
    for (let y = asset.storefront ? 6 : 2.8; y < height - 1.6; y += asset.floorHeight) {
      if (asset.facade === "glass") {
        surface("glass ribbon", 0, y, span - 1, 2.7, 0.04, "#486f78");
        surface("floor band", 0, y - 1.45, span, 0.18, 0.08, asset.trim);
        for (let u = -span / 2 + 2; u < span / 2 - 1; u += 4)
          surface("glass mullion", u, y, 0.16, 2.8, 0.09, asset.trim);
      } else {
        for (
          let u = -span / 2 + 2;
          u < span / 2 - 1;
          u += asset.facade === "industrial" ? 5 : 3.4
        ) {
          const window = surface(
            "window",
            u,
            y,
            asset.facade === "industrial" ? 2.6 : 1.5,
            1.6,
            0.05,
            "#4c7779",
          );
          if (random() < 0.42) window.material = scene.lighting.windows;
        }
        if (asset.facade === "balconies") {
          surface("balcony shadow", 0, y - 0.85, span - 1.2, 0.45, 0.08, "#6d827a");
          surface("balcony ledge", 0, y - 1.1, span - 0.6, 0.2, 0.35, asset.trim);
        }
      }
    }
    if (asset.facade === "piers") {
      for (let u = -span / 2 + 0.7; u <= span / 2; u += 3.5)
        surface("deco pier", u, height / 2, 0.45, height - 0.8, 0.14, asset.trim);
      for (let y = height - 2.4; y < height; y += 0.8)
        surface("deco crown", 0, y, span + 0.2, 0.25, 0.17, asset.trim);
    }
    if (asset.facade === "industrial") {
      surface("brick belt", 0, height - 0.8, span, 0.5, 0.12, asset.trim);
    }
  }
  box("entrance", 0, 1.4, -d / 2 - 0.035, Math.min(3, w / 3), 2.8, 0.07, "#365c5e");
  const accent = ["#b86650", "#4e877b", "#c59d55"][b.style % 3];
  if (asset.storefront) {
    box("shop glazing", 0, 1.6, -d / 2 - 0.06, w - 1.4, 2.5, 0.1, "#385c5d");
    for (let j = 0; j < 8; j++)
      box(
        "canvas awning",
        -w / 2 + 0.7 + ((j + 0.5) * (w - 1.4)) / 8,
        3.2,
        -d / 2 - 0.55,
        (w - 1.4) / 8,
        0.2,
        1.1,
        j % 2 ? "#eedfc0" : accent,
        true,
      );
    // A compact coloured fascia keeps signage readable without one texture per shop.
    box("shop fascia", 0, 3.9, -d / 2 - 0.09, w - 1.5, 0.65, 0.13, accent);
    if (index % 3 === 0) {
      const labels =
        b.asset === "hotel"
          ? ["HOTEL PALOMA"]
          : b.asset === "market-hall"
            ? ["MERCADO SOL"]
            : ["CAFE SOL", "RECORDS", "BODEGA", "PIZZA"];
      const z = -d / 2 - 0.18;
      const sign = scene.sign(
        labels[index % labels.length],
        b.x - z * Math.sin(angle),
        base + 4.1,
        b.z + z * Math.cos(angle),
        accent,
        Math.min(6, w - 2),
      );
      sign.rotation.y = -angle;
    }
  } else if (b.asset === "warehouse") {
    box(
      "loading shutter",
      0,
      1.8,
      -d / 2 - 0.06,
      Math.min(w - 2, 6),
      3.6,
      0.12,
      "#718080",
    );
    for (let y = 0.5; y < 3.5; y += 0.55)
      box(
        "shutter slat",
        0,
        y,
        -d / 2 - 0.13,
        Math.min(w - 2, 6),
        0.06,
        0.025,
        asset.trim,
      );
  } else {
    box(
      "entry canopy",
      0,
      3,
      -d / 2 - 0.45,
      Math.min(w - 1, 4),
      0.22,
      0.9,
      asset.trim,
      true,
    );
  }
  // Roof paint, not geometry above the collision envelope.
  if (height > 35 && index % 3 === 0) {
    box(
      "helipad",
      0,
      height + 0.03,
      0,
      Math.min(w - 2, 9),
      0.025,
      Math.min(d - 2, 9),
      "#586e68",
    );
    for (const x of [-1.3, 1.3])
      box("helipad H", x, height + 0.05, 0, 0.4, 0.015, 3.5, "#e8d9af");
    box("helipad H", 0, height + 0.05, 0, 2.6, 0.015, 0.4, "#e8d9af");
  }
}
