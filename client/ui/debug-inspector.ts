import type { Node } from "@babylonjs/core/node";
import type { CityScene } from "../scene.ts";

export function inspectAtPointer(host: CityScene, x: number, y: number) {
  const canvas = host.engine.getRenderingCanvas();
  if (!canvas) return undefined;
  const rect = canvas.getBoundingClientRect();
  const hit = host.scene.pick(
    ((x - rect.left) * canvas.clientWidth) / rect.width,
    ((y - rect.top) * canvas.clientHeight) / rect.height,
    (mesh) => mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0,
  );
  if (!hit?.pickedMesh) return undefined;
  const roots = new Map<Node, string>([...host.nodes].map(([id, node]) => [node, id]));
  let node: Node | null = hit.pickedMesh;
  while (node) {
    const id = roots.get(node);
    if (id) return { kind: "entity" as const, id };
    node = node.parent;
  }
  return {
    kind: "scenery" as const,
    name: hit.pickedMesh.name,
    data: JSON.stringify(
      {
        mesh: hit.pickedMesh.name,
        position: hit.pickedPoint?.asArray(),
        vertices: hit.pickedMesh.getTotalVertices(),
        triangles: hit.pickedMesh.getTotalIndices() / 3,
        note: "Static scenery has no AI state. Batched meshes may contain several objects.",
      },
      null,
      2,
    ),
  };
}
