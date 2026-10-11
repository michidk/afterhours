export class SpatialGrid<T> {
  private cells = new Map<string, Set<T>>();
  constructor(private size = 16) {}
  clear() {
    this.cells.clear();
  }
  insert(item: T, x: number, z: number, radius = 0) {
    for (
      let ix = Math.floor((x - radius) / this.size);
      ix <= Math.floor((x + radius) / this.size);
      ix++
    )
      for (
        let iz = Math.floor((z - radius) / this.size);
        iz <= Math.floor((z + radius) / this.size);
        iz++
      ) {
        const key = `${ix}:${iz}`,
          cell = this.cells.get(key) || new Set<T>();
        cell.add(item);
        this.cells.set(key, cell);
      }
  }
  query(x: number, z: number, radius: number) {
    const result = new Set<T>();
    for (
      let ix = Math.floor((x - radius) / this.size);
      ix <= Math.floor((x + radius) / this.size);
      ix++
    )
      for (
        let iz = Math.floor((z - radius) / this.size);
        iz <= Math.floor((z + radius) / this.size);
        iz++
      )
        for (const item of this.cells.get(`${ix}:${iz}`) || []) result.add(item);
    return [...result];
  }
}
