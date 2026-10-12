export class SpatialGrid<T> {
  private cells = new Map<number, Map<number, Set<T>>>();
  private queries = new Map<string, T[]>();
  constructor(private size = 16) {}
  clear() {
    this.cells.clear();
    this.queries.clear();
  }
  insert(item: T, x: number, z: number, radius = 0) {
    this.queries.clear();
    for (
      let ix = Math.floor((x - radius) / this.size);
      ix <= Math.floor((x + radius) / this.size);
      ix++
    ) {
      let column = this.cells.get(ix);
      if (!column) this.cells.set(ix, (column = new Map()));
      for (
        let iz = Math.floor((z - radius) / this.size);
        iz <= Math.floor((z + radius) / this.size);
        iz++
      ) {
        const cell = column.get(iz) || new Set<T>();
        cell.add(item);
        column.set(iz, cell);
      }
    }
  }
  query(x: number, z: number, radius: number) {
    const minX = Math.floor((x - radius) / this.size),
      maxX = Math.floor((x + radius) / this.size),
      minZ = Math.floor((z - radius) / this.size),
      maxZ = Math.floor((z + radius) / this.size),
      key = `${minX}:${maxX}:${minZ}:${maxZ}`;
    const cached = this.queries.get(key);
    if (cached) return cached.slice();
    const result = new Set<T>();
    for (let ix = minX; ix <= maxX; ix++) {
      const column = this.cells.get(ix);
      if (!column) continue;
      for (let iz = minZ; iz <= maxZ; iz++)
        for (const item of column.get(iz) || []) result.add(item);
    }
    const items = [...result];
    if (this.queries.size >= 4096) this.queries.clear();
    this.queries.set(key, items);
    return items.slice();
  }
}
