export class SpatialGrid<T> {
  private cells = new Map<number, Map<number, T[]>>();
  private queries = new Map<string, T[]>();
  private spareCells: T[][] = [];
  private spareColumns: Map<number, T[]>[] = [];
  private visited = new Map<T, number>();
  private queryId = 0;
  constructor(
    private size = 16,
    private cacheQueries = true,
  ) {}
  clear() {
    for (const column of this.cells.values()) {
      for (const cell of column.values()) {
        cell.length = 0;
        this.spareCells.push(cell);
      }
      column.clear();
      this.spareColumns.push(column);
    }
    this.cells.clear();
    this.queries.clear();
    this.visited.clear();
  }
  insert(item: T, x: number, z: number, radius = 0) {
    this.queries.clear();
    for (
      let ix = Math.floor((x - radius) / this.size);
      ix <= Math.floor((x + radius) / this.size);
      ix++
    ) {
      let column = this.cells.get(ix);
      if (!column) this.cells.set(ix, (column = this.spareColumns.pop() ?? new Map()));
      for (
        let iz = Math.floor((z - radius) / this.size);
        iz <= Math.floor((z + radius) / this.size);
        iz++
      ) {
        const cell = column.get(iz) ?? this.spareCells.pop() ?? [];
        if (!cell.includes(item)) cell.push(item);
        column.set(iz, cell);
      }
    }
  }
  query(x: number, z: number, radius: number) {
    const minX = Math.floor((x - radius) / this.size),
      maxX = Math.floor((x + radius) / this.size),
      minZ = Math.floor((z - radius) / this.size),
      maxZ = Math.floor((z + radius) / this.size),
      key = this.cacheQueries ? `${minX}:${maxX}:${minZ}:${maxZ}` : undefined;
    const cached = key === undefined ? undefined : this.queries.get(key);
    if (cached) return cached.slice();
    const items: T[] = [],
      queryId = ++this.queryId;
    for (let ix = minX; ix <= maxX; ix++) {
      const column = this.cells.get(ix);
      if (!column) continue;
      for (let iz = minZ; iz <= maxZ; iz++)
        for (const item of column.get(iz) || []) {
          if (this.visited.get(item) === queryId) continue;
          this.visited.set(item, queryId);
          items.push(item);
        }
    }
    if (key !== undefined) {
      if (this.queries.size >= 4096) this.queries.clear();
      this.queries.set(key, items);
      return items.slice();
    }
    return items;
  }
}
