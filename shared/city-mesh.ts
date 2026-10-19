import { z } from "zod";

const floats = z.array(z.number().finite()).max(2000000);
export const staticMeshSchema = z
  .object({
    name: z.string().max(100),
    positions: floats,
    normals: floats,
    indices: z.array(z.number().int().nonnegative()).max(3000000),
    uvs: floats.optional(),
    colors: floats.optional(),
    material: z.object({
      role: z.enum(["plain", "windows", "glow", "sign", "pool"]),
      color: z.string(),
      emissive: z.string(),
      specular: z.string(),
      backFaceCulling: z.boolean().optional(),
      text: z.string().optional(),
      background: z.string().optional(),
    }),
    shadow: z.boolean(),
  })
  .superRefine((mesh, context) => {
    const vertices = mesh.positions.length / 3;
    if (
      !Number.isInteger(vertices) ||
      !vertices ||
      mesh.normals.length !== mesh.positions.length ||
      mesh.indices.length % 3 ||
      mesh.indices.some((index) => index >= vertices) ||
      (mesh.uvs && mesh.uvs.length !== vertices * 2) ||
      (mesh.colors && mesh.colors.length !== vertices * 4)
    )
      context.addIssue({ code: "custom", message: "Invalid static vertex buffers" });
  });
export const meshGroupSchema = z.array(staticMeshSchema).max(500);
type SavedMesh = z.infer<typeof staticMeshSchema>;
/** Validated meshes may own transferred GPU buffers instead of boxed JSON numbers. */
export type MeshGroup = (Omit<
  SavedMesh,
  "positions" | "normals" | "indices" | "uvs" | "colors"
> & {
  positions: number[] | Float32Array;
  normals: number[] | Float32Array;
  indices: number[] | Uint32Array;
  uvs?: number[] | Float32Array;
  colors?: number[] | Float32Array;
})[];
export const chunkGeometrySchema = z.object({
  version: z.literal(1),
  features: z.record(z.string(), meshGroupSchema),
  fixtures: z.record(z.string(), meshGroupSchema),
  airport: meshGroupSchema.optional(),
});
export type ChunkGeometry = {
  version: 1;
  features: Record<string, MeshGroup>;
  fixtures: Record<string, MeshGroup>;
  airport?: MeshGroup;
};
