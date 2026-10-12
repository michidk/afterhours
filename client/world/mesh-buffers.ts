import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { MeshGroup } from "../../shared/city-mesh.ts";
import type { CityScene } from "../scene.ts";
import { CameraDither } from "./camera-dither.ts";

/** Upload saved vertex buffers; no procedural builders or merging on this path. */
export function uploadMeshes(host: CityScene, group: MeshGroup) {
  return group.map((saved) => {
    const mesh = new Mesh(saved.name, host.scene);
    const data = new VertexData();
    Object.assign(data, {
      positions: saved.positions,
      normals: saved.normals,
      indices: saved.indices,
      uvs: saved.uvs,
      colors: saved.colors,
    });
    data.applyToMesh(mesh);
    if (saved.name === "island terrain") {
      mesh.subdivide(Math.min(64, saved.indices.length / 3));
      mesh.cullingStrategy = Mesh.CULLINGSTRATEGY_STANDARD;
    }
    const m = saved.material;
    if (m.role === "windows") mesh.material = host.lighting.windows;
    else if (m.role === "glow") mesh.material = host.streetGlow;
    else if (m.role === "pool") mesh.material = host.lighting.poolMaterial;
    else if (m.role === "sign") {
      const material = new StandardMaterial("lettering", host.scene);
      const texture = new DynamicTexture(
        "sign",
        { width: 512, height: 128 },
        host.scene,
        false,
      );
      texture.drawText(
        m.text ?? "",
        null,
        91,
        "bold 66px sans-serif",
        "#fff5db",
        m.background ?? "#467b72",
        true,
      );
      material.diffuseTexture = texture;
      material.emissiveColor = Color3.FromHexString(m.emissive);
      material.specularColor = Color3.FromHexString(m.specular);
      material.maxSimultaneousLights = 6;
      host.lighting.signs.push(material);
      new CameraDither(material);
      mesh.material = material;
    } else {
      const key = `saved:${m.color}:${m.emissive}:${m.specular}:${m.backFaceCulling}`;
      let material = host.materials.get(key);
      if (!material) {
        material = new StandardMaterial(key, host.scene);
        material.backFaceCulling = m.backFaceCulling ?? true;
        material.diffuseColor = Color3.FromHexString(m.color);
        material.emissiveColor = Color3.FromHexString(m.emissive);
        material.specularColor = Color3.FromHexString(m.specular);
        material.maxSimultaneousLights = 6;
        new CameraDither(material);
        host.materials.set(key, material);
      }
      mesh.material = material;
    }
    mesh.receiveShadows = m.role !== "pool";
    if (saved.shadow) {
      host.shadows.addShadowCaster(mesh);
      host.shadowCandidates.push(mesh);
    }
    return mesh;
  });
}
