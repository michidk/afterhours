import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  CITY_CHUNK_SIZE,
  STATIC_FIELDS,
  chunksAround,
  type CityChunk,
  type MapManifest,
  type CityAtlas,
} from "../shared/city-stream.ts";
import { packHeights } from "../shared/city-pack.ts";
import { LIMIT, type City } from "../shared/world.ts";

/** A response body kept both raw and gzip-compressed, picked per request. */
class Body {
  readonly raw: Buffer;
  readonly gzip: Buffer;
  constructor(
    data: string | Uint8Array,
    readonly type: string,
  ) {
    this.raw = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    this.gzip = gzipSync(this.raw, { level: 6 });
  }
  send(req: IncomingMessage, res: ServerResponse) {
    const accepts = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    res.setHeader("Content-Type", this.type);
    // No browser-persisted map: geometry lives only in the active client's memory.
    res.setHeader("Cache-Control", "no-store");
    if (accepts) res.setHeader("Content-Encoding", "gzip");
    res.end(accepts ? this.gzip : this.raw);
  }
}

/** Index the loaded artifact once. This does not generate or modify the map. */
export class CityStore {
  readonly manifest: MapManifest;
  readonly chunks = new Map<string, CityChunk>();
  readonly atlas: CityAtlas;
  private atlasBody: Body;
  private bodies = new Map<string, Body>();
  private terrainBody?: Body;
  private waterBody?: Body;
  private baseGeometry?: Body;
  constructor(city: City) {
    this.manifest = {
      version: 1,
      mapId: createHash("sha256").update(JSON.stringify(city)).digest("hex"),
      seed: city.seed,
      limit: LIMIT,
      chunkSize: CITY_CHUNK_SIZE,
      airport: city.airport,
      airports: city.airports,
      centre: city.centre,
      hasTerrain: city.terrain ? true : undefined,
      surface: city.surface ? true : undefined,
      hasWater: city.water ? true : undefined,
    };
    // Heights travel as little-endian int16 centimetres, not as JSON numbers.
    if (city.terrain)
      this.terrainBody = new Body(
        packHeights(city.terrain.heights),
        "application/octet-stream",
      );
    if (city.water)
      this.waterBody = new Body(JSON.stringify(city.water), "application/json");
    this.atlas = {
      mapId: this.manifest.mapId,
      roads: city.roads.map(({ ax, az, bx, bz, width }) => ({ ax, az, bx, bz, width })),
      parks: city.parks,
      landmarks: city.landmarks,
      ramps: city.ramps,
      racetrack: city.racetrack,
    };
    this.atlasBody = new Body(JSON.stringify(this.atlas), "application/json");
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
        surface: city.surface?.[key],
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
    for (const [key, chunk] of this.chunks)
      this.bodies.set(key, new Body(JSON.stringify(chunk), "application/json"));
  }
  installGeometry(base: Uint8Array, chunks: Record<string, Uint8Array>) {
    this.baseGeometry = new Body(gunzipSync(base), "application/json");
    this.manifest.geometryVersion = 1;
    this.bodies = new Map(
      Object.entries(chunks).map(([key, bytes]) => [
        key,
        new Body(gunzipSync(bytes), "application/json"),
      ]),
    );
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
    const geometry = /^\/city\/geometry\/([0-9a-f]{64})\/base$/.exec(path);
    if (geometry) {
      if (geometry[1] !== this.manifest.mapId)
        res.writeHead(409).end("Map changed; reload the city");
      else if (!this.baseGeometry) res.writeHead(404).end("No saved geometry");
      else this.baseGeometry.send(req, res);
      return true;
    }
    const named = /^\/city\/(terrain|atlas|water)\/([0-9a-f]{64})$/.exec(path);
    if (named) {
      if (named[2] !== this.manifest.mapId)
        res.writeHead(409).end("Map changed; reload the city");
      else if (named[1] === "atlas") this.atlasBody.send(req, res);
      else if (named[1] === "water")
        if (this.waterBody) this.waterBody.send(req, res);
        else res.writeHead(404).end("No water");
      else if (this.terrainBody) this.terrainBody.send(req, res);
      else res.writeHead(404).end("No terrain");
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
    body.send(req, res);
    return true;
  }
}
