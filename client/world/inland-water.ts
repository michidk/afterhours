import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { SCENE_LIGHT_COUNT } from "../lighting/index.ts";
import type { CityScene } from "../scene.ts";
import { LIMIT } from "../../shared/world.ts";
import { TERRAIN_SIDE, TERRAIN_STEP, terrainHeight } from "../../shared/terrain.ts";

/** Inland water stays at its authoritative height; only the lighting and colour move. */
export class InlandWaterRenderer extends MaterialPluginBase {
  time = 0;
  private depth: RawTexture;
  constructor(host: Pick<CityScene, "city" | "scene">) {
    const material = new StandardMaterial("inland water surface", host.scene);
    material.specularColor = new Color3(0.2, 0.28, 0.24);
    material.specularPower = 48;
    material.maxSimultaneousLights = SCENE_LIGHT_COUNT;
    super(material, "InlandWater", 210, { INLAND_WATER: true });
    // Sixteen-bit height keeps shallow banks readable at elevated mountain lakes.
    const heights = new Uint8Array(TERRAIN_SIDE * TERRAIN_SIDE * 4);
    for (let z = 0; z < TERRAIN_SIDE; z++)
      for (let x = 0; x < TERRAIN_SIDE; x++) {
        const height = terrainHeight(
          x * TERRAIN_STEP - LIMIT,
          z * TERRAIN_STEP - LIMIT,
          host.city,
        );
        const packed = Math.round(
          Math.max(0, Math.min(1, (height + 128) / 512)) * 65535,
        );
        const i = (z * TERRAIN_SIDE + x) * 4;
        heights[i] = packed >> 8;
        heights[i + 1] = packed & 255;
        heights[i + 3] = 255;
      }
    this.depth = RawTexture.CreateRGBATexture(
      heights,
      TERRAIN_SIDE,
      TERRAIN_SIDE,
      host.scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE,
    );
    this.depth.wrapU = this.depth.wrapV = Texture.CLAMP_ADDRESSMODE;
    this._enable(true);
    // Saved meshes have independent materials, so assign by water identity, not colour.
    for (const mesh of host.scene.meshes)
      if (mesh.name === "inland water") mesh.material = material;
  }
  override getClassName() {
    return "InlandWater";
  }
  override getAttributes(attributes: string[]) {
    attributes.push("uv");
  }
  override getSamplers(samplers: string[]) {
    samplers.push("inlandTerrain");
  }
  override getUniforms() {
    return {
      ubo: [{ name: "inlandTime", size: 1, type: "float" }],
      vertex: "uniform float inlandTime;",
      fragment: "uniform float inlandTime;",
    };
  }
  override bindForSubMesh(ubo: UniformBuffer) {
    ubo.updateFloat("inlandTime", this.time);
    ubo.setTexture("inlandTerrain", this.depth);
  }
  override getCustomCode(shaderType: string): Record<string, string> {
    if (shaderType === "vertex")
      return {
        CUSTOM_VERTEX_DEFINITIONS:
          "varying vec2 vInland;\n#ifndef UV1\nattribute vec2 uv;\n#endif",
        CUSTOM_VERTEX_MAIN_END: "vInland = uv;",
      };
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: `
varying vec2 vInland;
uniform sampler2D inlandTerrain;
float inlandHash(vec2 p) {
  vec3 q = fract(vec3(mod(p, 289.0).xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float inlandNoise(vec2 p) {
  vec2 cell = floor(p), u = fract(p);
  u = u * u * (3.0 - 2.0 * u);
  return mix(mix(inlandHash(cell), inlandHash(cell + vec2(1., 0.)), u.x),
    mix(inlandHash(cell + vec2(0., 1.)), inlandHash(cell + 1.), u.x), u.y);
}`,
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `
vec2 terrainUV = ((vPositionW.xz + ${LIMIT.toFixed(1)}) / ${TERRAIN_STEP.toFixed(1)} + 0.5) / ${TERRAIN_SIDE.toFixed(1)};
vec2 packedHeight = texture2D(inlandTerrain, terrainUV).rg;
float bed = dot(packedHeight, vec2(65280.0, 255.0)) / 65535.0 * 512.0 - 128.0;
float river = 1.0 - step(1.5, vInland.x);
float bank = 1.0 - abs(vInland.x);
float depth = mix(max(0.0, vPositionW.y - bed), max(0.0, bank) * 2.2, river);
vec2 p = mix(vPositionW.xz, vec2(vInland.x * 3.0, vInland.y), river);
float t = inlandTime;
float broad = inlandNoise(p * 0.13 + vec2(t * 0.025, -t * 0.04));
float ripple = sin(p.y * mix(0.85, 1.9, river) - t * mix(0.7, 2.8, river) + sin(p.x * 2.3) * 0.65 + broad * 4.0);
float shoal = 1.0 - smoothstep(0.1, 1.6, depth);
diffuseColor = mix(vec3(0.09, 0.34, 0.37), vec3(0.28, 0.52, 0.45), shoal);
diffuseColor += broad * 0.022;
float glint = smoothstep(0.93, 0.995, ripple) * smoothstep(0.58, 0.78, broad);
diffuseColor = mix(diffuseColor, vec3(0.66, 0.82, 0.72), glint * 0.16);
float edge = (1.0 - smoothstep(0.02, 0.28, depth)) * (0.65 + 0.35 * broad);
diffuseColor = mix(diffuseColor, vec3(0.74, 0.78, 0.56), edge * 0.25);
float detail = 1.0 - smoothstep(60.0, 230.0, length(vPositionW - vEyePosition.xyz));
normalW = normalize(normalW + vec3(ripple * 0.025, 0.0, broad * 0.035) * detail);`,
    };
  }
}
