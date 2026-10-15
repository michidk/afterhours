import { airportsOf } from "../../shared/world.ts";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Scene } from "@babylonjs/core/scene";
import type { WorldEvent, City } from "../../shared/world.ts";
import { terrainHeight } from "../../shared/terrain.ts";
import {
  paintTrail,
  trailTiles,
  TRAIL_TEXTURE_SIZE as SIZE,
  TRAIL_TILE_WIDTH as WIDTH,
  TRAIL_TILE_LIMIT,
  TRAIL_LIFT,
  TRAIL_AIRFIELD_LIFT,
  TRAIL_LIFETIME,
  TRAIL_MARK_LIMIT,
  trailShade,
  trailTileGeometry,
  type TrailMark,
} from "./trail-data.ts";

type Tile = { texture: DynamicTexture; material: StandardMaterial; mesh: Mesh };
/** Sparse, constant-resolution atlas. Distant tiles dispose their GPU resources. */
export class SkidTrails {
  marks: TrailMark[] = [];
  uploads = 0;
  lastUploadMs = 0;
  private clock = 0;
  private dirty = new Set<string>();
  private tiles = new Map<string, Tile>();
  get residentTiles() {
    return this.tiles.size;
  }
  constructor(
    private scene: Scene,
    private city?: City,
  ) {}

  add(e: WorldEvent) {
    if (![e.x, e.z, e.angle ?? 0, e.length ?? 0.15].every(Number.isFinite)) return;
    const length = Math.min(3.1, Math.max(0.08, e.length ?? 0.15)),
      tiles = trailTiles(e.x, e.z, length);
    this.marks.push({
      x: e.x,
      z: e.z,
      angle: e.angle ?? 0,
      length,
      life: TRAIL_LIFETIME,
      tiles,
      shade: 1,
    });
    for (const tile of tiles) this.dirty.add(tile);
    if (this.marks.length > TRAIL_MARK_LIMIT)
      for (const tile of this.marks.shift()!.tiles) this.dirty.add(tile);
  }

  update(dt: number, focus?: { x: number; z: number }) {
    const byTile = new Map<string, TrailMark[]>();
    this.clock += dt;
    // Fading is checked once a second; a tile repaints only when a mark's shade steps.
    const fade = this.clock >= 1;
    if (fade) this.clock = 0;
    for (const mark of this.marks) {
      mark.life -= dt;
      const shade = fade || mark.life <= 0 ? trailShade(mark.life) : mark.shade;
      const changed = shade !== mark.shade;
      mark.shade = shade;
      for (const key of mark.tiles) {
        if (changed || mark.life <= 0) this.dirty.add(key);
        if (mark.life <= 0) continue;
        const marks = byTile.get(key) ?? [];
        marks.push(mark);
        byTile.set(key, marks);
      }
    }
    this.marks = this.marks.filter((m) => m.life > 0);
    const center = focus ?? this.marks.at(-1) ?? { x: 0, z: 0 },
      distance = (key: string) => {
        const [col, row] = key.split(",").map(Number);
        return Math.hypot(
          (col + 0.5) * WIDTH - center.x,
          (row + 0.5) * WIDTH - center.z,
        );
      },
      wanted = new Set(
        [...byTile.keys()]
          .filter((key) => distance(key) < 145)
          .sort((a, b) => distance(a) - distance(b))
          .slice(0, TRAIL_TILE_LIMIT),
      );
    for (const [key, tile] of this.tiles)
      if (!wanted.has(key)) {
        tile.mesh.dispose();
        tile.material.dispose();
        tile.texture.dispose();
        this.tiles.delete(key);
      }
    const started = performance.now();
    for (const key of wanted) {
      const [col, row] = key.split(",").map(Number);
      let tile = this.tiles.get(key);
      if (!tile) {
        const texture = new DynamicTexture(
          `tyre trails ${key}`,
          { width: SIZE, height: SIZE },
          this.scene,
          false,
        );
        texture.hasAlpha = true;
        const airfield =
          !!this.city &&
          airportsOf(this.city).some(
            (airport) =>
              col * WIDTH < airport.x + airport.w / 2 &&
              (col + 1) * WIDTH > airport.x - airport.w / 2 &&
              row * WIDTH < airport.z + airport.d / 2 &&
              (row + 1) * WIDTH > airport.z - airport.d / 2,
          );
        const geometry = trailTileGeometry(
          col,
          row,
          (x, z) => terrainHeight(x, z, this.city),
          airfield ? TRAIL_AIRFIELD_LIFT : TRAIL_LIFT,
        );
        const mesh = new Mesh(`tyre trails ${key}`, this.scene),
          data = new VertexData(),
          normals: number[] = [];
        VertexData.ComputeNormals(geometry.positions, geometry.indices, normals);
        data.positions = geometry.positions;
        data.indices = geometry.indices;
        data.uvs = geometry.uvs;
        data.normals = normals;
        data.applyToMesh(mesh);
        mesh.position.set((col + 0.5) * WIDTH, 0, (row + 0.5) * WIDTH);
        mesh.isPickable = false;
        mesh.freezeWorldMatrix();
        const material = new StandardMaterial(`rubber ${key}`, this.scene);
        material.diffuseTexture = texture;
        material.useAlphaFromDiffuseTexture = true;
        material.disableLighting = true;
        material.backFaceCulling = false;
        material.emissiveColor = Color3.White();
        material.specularColor = Color3.Black();
        mesh.material = material;
        tile = { texture, material, mesh };
        this.tiles.set(key, tile);
        this.dirty.add(key);
      }
      if (!this.dirty.has(key)) continue;
      const ctx = tile.texture.getContext() as CanvasRenderingContext2D;
      ctx.clearRect(0, 0, SIZE, SIZE);
      for (const mark of byTile.get(key) ?? []) paintTrail(ctx, mark, col, row);
      tile.texture.update();
      this.uploads++;
    }
    this.lastUploadMs = performance.now() - started;
    this.dirty.clear();
  }
}
