import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { CityScene } from "../scene.ts";

/** Inflated ram-air cells with suspension lines attached to a shoulder harness. */
export function buildParachute(host: CityScene, root: TransformNode) {
  for (let cell = 0; cell < 7; cell++) {
    const paths: Vector3[][] = [];
    for (const x of [-2.6 + (cell * 5.2) / 7, -2.6 + ((cell + 1) * 5.2) / 7]) {
      paths.push(
        Array.from({ length: 7 }, (_, i) => {
          const t = i / 6;
          return new Vector3(
            x,
            4.3 + 0.65 * (1 - (x / 2.6) ** 2) + Math.sin(t * Math.PI) * 0.45,
            -1.4 + t * 2.8,
          );
        }),
      );
    }
    const panel = MeshBuilder.CreateRibbon(
      "parachute cell",
      { pathArray: paths, sideOrientation: Mesh.DOUBLESIDE },
      host.scene,
    );
    panel.material = host.mat(
      cell === 3 ? "#fff0d3" : cell % 2 ? "#426e75" : "#edaa54",
    );
    panel.parent = root;
    panel.setEnabled(false);
    host.shadows.addShadowCaster(panel);
  }
  for (const x of [-2.4, -1.6, -0.8, 0.8, 1.6, 2.4])
    for (const z of [-1.3, 1.3]) {
      const line = MeshBuilder.CreateLines(
        "parachute suspension",
        {
          points: [
            new Vector3(x, 4.3 + 0.65 * (1 - (x / 2.6) ** 2), z),
            new Vector3(Math.sign(x) * 0.32, 1.35, 0),
          ],
        },
        host.scene,
      );
      line.color = Color3.FromHexString("#f4e8cb");
      line.parent = root;
      line.setEnabled(false);
    }
  for (const x of [-0.26, 0.26])
    host
      .box("parachute harness", x, 1.05, 0.2, 0.09, 0.8, 0.08, "#263237", root)
      .setEnabled(false);
  host
    .box("parachute belt", 0, 0.8, 0.18, 0.65, 0.1, 0.15, "#263237", root)
    .setEnabled(false);
}
