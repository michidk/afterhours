import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { Material } from "@babylonjs/core/Materials/material";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { CityScene } from "../scene.ts";
import { LIMIT, type City } from "../../shared/world.ts";
import { TERRAIN_SIDE, TERRAIN_STEP, terrainHeight } from "../../shared/terrain.ts";
import { SURF, WATER_LEVEL, WAVES } from "../../shared/water.ts";

/** Sea depth is packed into one byte over this range of metres. */
const DEPTH = { min: -4, range: 20 };
/** Grid vertex u ∈ [-1, 1] sits at NEAR·u + FAR·u⁹ metres from the camera: dense close up. */
const GRID = 256,
  NEAR = 220,
  FAR = 5780,
  CELL = (2 * NEAR) / GRID;
const f = (v: number) => v.toFixed(6);

/** shared/water.ts seaWave in GLSL, with short waves faded out where the grid is too coarse. */
const WAVE_GLSL = `
uniform sampler2D waveDepth;
float seaDepth(vec2 p) {
  if (max(abs(p.x), abs(p.y)) > ${f(LIMIT)}) return ${f(WATER_LEVEL + 12)};
  vec2 uv = ((p + ${f(LIMIT)}) / ${f(TERRAIN_STEP)} + 0.5) / ${f(TERRAIN_SIDE)};
  return texture2D(waveDepth, uv).r * ${f(DEPTH.range)} + ${f(DEPTH.min)};
}
float seaWave(vec2 p, float depth, float dist, out vec2 slope) {
  float h = 0.0, s, a;
  slope = vec2(0.0);
  ${WAVES.map(
    (w) => `
  a = ${f(w.height)} * (1.0 - smoothstep(${f(w.length * 8)}, ${f(w.length * 16)}, dist));
  s = ${f(w.k)} * dot(vec2(${f(w.dx)}, ${f(w.dz)}), p) - ${f(w.omega)} * waveTime + ${f(w.phase)};
  h += a * sin(s);
  slope += a * ${f(w.k)} * vec2(${f(w.dx)}, ${f(w.dz)}) * cos(s);`,
  ).join("")}
  float shoal = smoothstep(0.0, ${f(SURF.shoal)}, depth);
  float lap = smoothstep(-0.5, 0.0, depth) * (1.0 - smoothstep(0.5, ${f(SURF.reach)}, depth));
  slope *= shoal;
  return h * shoal + ${f(SURF.swash)} * lap * sin(1.2 * waveTime + 1.4 * depth + 0.02 * (p.x + p.y));
}
// Sine-free hash on wrapped cells: sin() hashes speckle at world-sized coordinates.
float waterHash(vec2 p) {
  vec3 q = fract(vec3(mod(p, 289.0).xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float waterNoise(vec2 p) {
  vec2 i = floor(p), u = fract(p);
  u = u * u * (3.0 - 2.0 * u);
  return mix(mix(waterHash(i), waterHash(i + vec2(1.0, 0.0)), u.x),
             mix(waterHash(i + vec2(0.0, 1.0)), waterHash(i + 1.0), u.x), u.y);
}
varying float vSea;`;

/**
 * Displaces the sea grid on the GPU with the same swell the server floats bodies on, and
 * shades all water: depth tint, shore and crest foam, ripples and a sky fresnel. Being a
 * StandardMaterial plugin, lights, shadows and fog keep working.
 */
class WaterSurface extends MaterialPluginBase {
  time = 0;
  constructor(
    material: Material,
    private depth: RawTexture,
  ) {
    super(material, "WaterSurface", 210, { WATER_SURFACE: true });
    this._enable(true);
  }
  override getClassName() {
    return "WaterSurface";
  }
  override getUniforms() {
    return {
      ubo: [{ name: "waveTime", size: 1, type: "float" }],
      vertex: "uniform float waveTime;",
      fragment: "uniform float waveTime;",
    };
  }
  override getSamplers(samplers: string[]) {
    samplers.push("waveDepth");
  }
  override bindForSubMesh(ubo: UniformBuffer) {
    ubo.updateFloat("waveTime", this.time);
    ubo.setTexture("waveDepth", this.depth);
  }
  override getCustomCode(shaderType: string): Record<string, string> {
    if (shaderType === "vertex")
      return {
        CUSTOM_VERTEX_DEFINITIONS: WAVE_GLSL,
        // Only the sea grid sits at sea level; lakes and rivers stay flat.
        CUSTOM_VERTEX_UPDATE_WORLDPOS: `
vSea = abs(worldPos.y - ${f(WATER_LEVEL)}) < 0.01 ? 1.0 : 0.0;
if (vSea > 0.5) {
  vec2 slope;
  worldPos.y += seaWave(worldPos.xz, seaDepth(worldPos.xz), length(worldPos.xz - finalWorld[3].xz), slope);
  vNormalW = normalize(vec3(-slope.x, 1.0, -slope.y));
}`,
      };
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: WAVE_GLSL,
      CUSTOM_FRAGMENT_UPDATE_DIFFUSE: `
float waterDepth = 3.0, waveH = 0.0;
vec2 waveSlope = vec2(0.0);
if (vSea > 0.5) {
  waterDepth = seaDepth(vPositionW.xz);
  waveH = seaWave(vPositionW.xz, waterDepth, length(vPositionW.xz - vEyePosition.xz), waveSlope);
}
float rippleFade = 1.0 - smoothstep(25.0, 140.0, length(vPositionW - vEyePosition.xyz));
vec2 rp = vPositionW.xz;
vec2 ripple = 0.06 * vec2(0.8, 0.6) * cos(dot(rp, vec2(0.8, 0.6)) * 2.1 - waveTime * 3.1)
  + 0.045 * vec2(-0.5, 0.87) * cos(dot(rp, vec2(-0.5, 0.87)) * 3.3 - waveTime * 3.9)
  + 0.03 * vec2(0.96, -0.28) * cos(dot(rp, vec2(0.96, -0.28)) * 5.2 - waveTime * 5.0);
waveSlope += ripple * rippleFade;
normalW = normalize(vec3(-waveSlope.x, 1.0, -waveSlope.y));
diffuseColor = mix(vec3(0.3, 0.64, 0.6), vec3(0.05, 0.21, 0.3), smoothstep(0.0, 7.0, waterDepth));
float foamNoise = 0.65 * waterNoise(rp * 0.35 + vec2(waveTime * 0.2, -waveTime * 0.12))
  + 0.35 * waterNoise(rp * 1.3 - vec2(waveTime * 0.3, waveTime * 0.1));
float shoreFoam = (1.0 - smoothstep(0.0, 1.3, waterDepth))
  * (0.55 + 0.45 * sin(waterDepth * 6.0 - waveTime * 2.2 + foamNoise * 3.0));
float crestFoam = smoothstep(0.38, 0.6, waveH) * 0.45;
float foam = clamp(max(shoreFoam, crestFoam) * smoothstep(0.2, 0.75, foamNoise + 0.25), 0.0, 1.0);
diffuseColor = mix(diffuseColor, vec3(0.93, 0.96, 0.95), foam);`,
      CUSTOM_FRAGMENT_BEFORE_FOG: `
#ifdef FOG
float fresnel = pow(1.0 - clamp(dot(normalW, viewDirectionW), 0.0, 1.0), 5.0);
color.rgb = mix(color.rgb, vFogColor, fresnel * 0.7 * (1.0 - foam));
#endif`,
    };
  }
}

/** WATER_LEVEL minus the terrain per grid point, for the shader's depth tint, foam and shoaling. */
function depthTexture(host: CityScene) {
  const data = new Uint8Array(TERRAIN_SIDE * TERRAIN_SIDE * 4);
  for (let gz = 0; gz < TERRAIN_SIDE; gz++)
    for (let gx = 0; gx < TERRAIN_SIDE; gx++) {
      const i = (gz * TERRAIN_SIDE + gx) * 4,
        depth =
          WATER_LEVEL -
          terrainHeight(
            gx * TERRAIN_STEP - LIMIT,
            gz * TERRAIN_STEP - LIMIT,
            host.city,
          );
      data[i] = Math.round(
        Math.max(0, Math.min(1, (depth - DEPTH.min) / DEPTH.range)) * 255,
      );
      data[i + 3] = 255;
    }
  const texture = RawTexture.CreateRGBATexture(
    data,
    TERRAIN_SIDE,
    TERRAIN_SIDE,
    host.scene,
    false,
    false,
    Texture.BILINEAR_SAMPLINGMODE,
  );
  texture.wrapU = texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  return texture;
}

/** Waves follow shared/water.ts seaWave, which the server floats boats and swimmers on. */
export class WaterRenderer {
  private mesh: Mesh;
  private surface: WaterSurface;
  constructor(private host: CityScene) {
    const positions: number[] = [],
      normals: number[] = [],
      indices: number[] = [];
    const warp = (u: number) => NEAR * u + FAR * u ** 9;
    for (let j = 0; j <= GRID; j++)
      for (let i = 0; i <= GRID; i++) {
        positions.push(warp((i / GRID) * 2 - 1), 0, warp((j / GRID) * 2 - 1));
        normals.push(0, 1, 0);
      }
    // Counter-clockwise in x/z, like the terrain, so the surface faces up.
    for (let j = 0; j < GRID; j++)
      for (let i = 0; i < GRID; i++) {
        const a = j * (GRID + 1) + i,
          b = a + GRID + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    this.mesh = new Mesh("animated water", host.scene);
    Object.assign(new VertexData(), { positions, normals, indices }).applyToMesh(
      this.mesh,
    );
    this.mesh.position.y = WATER_LEVEL;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.receiveShadows = true;
    // Lakes and rivers share this material, so the plugin shades them too.
    const material = host.mat("#478e9c");
    material.specularColor = new Color3(0.85, 0.8, 0.7);
    material.specularPower = 160;
    this.surface = new WaterSurface(material, depthTexture(host));
    this.mesh.material = material;
  }
  update(time: number) {
    this.surface.time = time;
    // Snap to whole cells so vertices never slide through the swell.
    const eye = this.host.camera.position;
    this.mesh.position.x = Math.round(eye.x / CELL) * CELL;
    this.mesh.position.z = Math.round(eye.z / CELL) * CELL;
  }
  dispose() {
    this.mesh.dispose();
  }
}
