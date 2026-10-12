import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CITY_CHUNK_SIZE,
  STATIC_FIELDS,
  chunksAround,
  type CityChunk,
  type MapManifest,
  type CityAtlas,
} from "../shared/city-stream.ts";
import { LIMIT, type City } from "../shared/world.ts";

/** Index the loaded artifact once. This does not generate or modify the map. */
export class CityStore {
  readonly manifest: MapManifest;
  readonly chunks = new Map<string, CityChunk>();
  readonly atlas: CityAtlas;
  private atlasBody: string;
  private bodies = new Map<string, string>();
  constructor(city: City) {
    this.manifest = {
      version: 1,
      mapId: createHash("sha256").update(JSON.stringify(city)).digest("hex"),
      seed: city.seed,
      limit: LIMIT,
      chunkSize: CITY_CHUNK_SIZE,
      airport: city.airport,
      terrain: city.terrain,
      centre: city.centre,
      surface: city.surface,
    };
    this.atlas = {
      mapId: this.manifest.mapId,
      roads: city.roads.map(({ ax, az, bx, bz, width }) => ({ ax, az, bx, bz, width })),
      parks: city.parks,
      landmarks: city.landmarks,
      ramps: city.ramps,
    };
    this.atlasBody = JSON.stringify(this.atlas);
    for (const key of chunksAround(0, 0, LIMIT))
      this.chunks.set(key, {
        mapId: this.manifest.mapId,
        key,
        roads: [],
        buildings: [],
        props: [],
        parks: [],
        surfaces: [],
        ramps: [],
        landmarks: [],
      });
    for (const field of STATIC_FIELDS)
      (city[field] ?? []).forEach((value, id) => {
        const sized = value as { x: number; z: number; w?: number; d?: number };
        const road = field === "roads" ? (value as City["roads"][number]) : undefined;
        const w = road
            ? Math.abs(road.bx - road.ax) + road.width + 28
            : (sized.w ?? (field === "parks" ? 38 : field === "landmarks" ? 30 : 12)),
          d = road
            ? Math.abs(road.bz - road.az) + road.width + 28
            : (sized.d ?? (field === "parks" ? 38 : field === "landmarks" ? 30 : 12));
        for (
          let x = Math.floor((value.x - w / 2) / CITY_CHUNK_SIZE);
          x <= Math.floor((value.x + w / 2) / CITY_CHUNK_SIZE);
          x++
        )
          for (
            let z = Math.floor((value.z - d / 2) / CITY_CHUNK_SIZE);
            z <= Math.floor((value.z + d / 2) / CITY_CHUNK_SIZE);
            z++
          ) {
            const chunk = this.chunks.get(`${x},${z}`);
            if (chunk)
              (chunk[field] as { id: number; value: typeof value }[]).push({
                id,
                value,
              });
          }
      });
    for (const [key, chunk] of this.chunks) this.bodies.set(key, JSON.stringify(chunk));
  }
  serve(req: IncomingMessage, res: ServerResponse) {
    const path = req.url?.split("?")[0];
    if (path === "/city") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(this.manifest));
      return true;
    }
    if (!path?.startsWith("/city/")) return false;
    const atlas = /^\/city\/atlas\/([0-9a-f]{64})$/.exec(path);
    if (atlas) {
      if (atlas[1] !== this.manifest.mapId) {
        res.writeHead(409).end("Map changed; reload the city");
        return true;
      }
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(this.atlasBody);
      return true;
    }
    const match = /^\/city\/chunks\/([0-9a-f]{64})\/(-?\d+)\/(-?\d+)$/.exec(path);
    if (!match) {
      res.writeHead(404).end("Unknown map chunk");
      return true;
    }
    if (match[1] !== this.manifest.mapId) {
      res.writeHead(409).end("Map changed; reload the city");
      return true;
    }
    const body = this.bodies.get(`${Number(match[2])},${Number(match[3])}`);
    if (!body) {
      res.writeHead(404).end("Outside the city");
      return true;
    }
    res.setHeader("Content-Type", "application/json");
    // No browser-persisted map: chunks live only in the active client's memory.
    res.setHeader("Cache-Control", "no-store");
    res.end(body);
    return true;
  }
}
