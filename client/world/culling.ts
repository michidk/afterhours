import { Octree } from "@babylonjs/core/Culling/Octrees/octree";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";
import { WORLD_LIMIT } from "../../shared/water.ts";

/** Index only immutable scenery; moving and newly created meshes remain candidates. */
export class SceneryCulling {
  private readonly indexed = new Set<AbstractMesh>();
  private readonly tree = new Octree<AbstractMesh>(Octree.CreationFuncForMeshes, 16, 5);
  private readonly min = new Vector3(-WORLD_LIMIT, -WORLD_LIMIT, -WORLD_LIMIT);
  private readonly max = new Vector3(WORLD_LIMIT, WORLD_LIMIT, WORLD_LIMIT);
  constructor(scene: Scene) {
    this.tree.update(this.min, this.max, []);
    scene.getActiveMeshCandidates = () => {
      const candidates = this.tree.select(scene.frustumPlanes);
      // Mesh-added notifications are deferred; scan the live list to include first-frame spawns.
      for (const mesh of scene.meshes)
        if (!this.indexed.has(mesh)) candidates.push(mesh);
      return candidates;
    };
    scene.onMeshRemovedObservable.add((mesh) => {
      if (this.indexed.delete(mesh)) this.tree.removeMesh(mesh);
    });
  }
  add(mesh: AbstractMesh) {
    if (this.indexed.has(mesh) || mesh.isDisposed()) return;
    mesh.computeWorldMatrix(true);
    const bounds = mesh.getBoundingInfo().boundingBox;
    if (
      bounds.minimumWorld.x < this.min.x ||
      bounds.minimumWorld.y < this.min.y ||
      bounds.minimumWorld.z < this.min.z ||
      bounds.maximumWorld.x > this.max.x ||
      bounds.maximumWorld.y > this.max.y ||
      bounds.maximumWorld.z > this.max.z
    )
      return;
    this.indexed.add(mesh);
    this.tree.addMesh(mesh);
  }
}
