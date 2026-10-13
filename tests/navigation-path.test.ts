import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCity } from "../scripts/city-generator.ts";
import { navigationFor, path } from "../shared/navigation.ts";

/** The search as it was written before the typed-array rewrite: the behaviour to preserve. */
function reference<T>(
  nodes: T[],
  start: number,
  goal: number,
  edges: (n: T) => number[],
): number[] {
  if (!nodes[start] || !nodes[goal]) return [];
  const queue = [start],
    parents = new Map([[start, -1]]);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (id === goal) break;
    for (const next of edges(nodes[id]))
      if (!parents.has(next)) {
        parents.set(next, id);
        queue.push(next);
      }
  }
  if (!parents.has(goal)) return [];
  const result = [goal];
  while (result[0] !== start) result.unshift(parents.get(result[0])!);
  return result;
}

test("routes match the original breadth-first search on the generated city", () => {
  const nav = navigationFor(generateCity());
  let seed = 11;
  const random = (n: number) =>
    (((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * n) | 0;
  let longest = 0;
  for (let i = 0; i < 300; i++) {
    const a = random(nav.roads.length),
      b = random(nav.roads.length);
    const expected = reference(nav.roads, a, b, (n) => n.edges);
    assert.deepEqual(nav.roadPath(a, b), expected, `road ${a} to ${b}`);
    longest = Math.max(longest, expected.length);
  }
  assert.ok(longest > 10, `the sample includes long routes: ${longest}`);
  for (let i = 0; i < 300; i++) {
    const a = random(nav.sidewalks.length),
      b = random(nav.sidewalks.length);
    const expected = reference(nav.sidewalks, a, b, (n) => n.edges.map((e) => e.id));
    const got = nav.sidewalkPath(a, b);
    assert.deepEqual(
      got.map((w) => [w.x, w.z]),
      expected.slice(1).map((id) => [nav.sidewalks[id].x, nav.sidewalks[id].z]),
      `sidewalk ${a} to ${b}`,
    );
  }
});

test("route search handles the same node, invalid ids, unreachable nodes and ties", () => {
  const graph = [[1, 2], [3], [3], [], []] as number[][];
  const edges = (n: number[]) => n;
  assert.deepEqual(path(graph, 0, 3, edges), [0, 1, 3], "ties resolve by edge order");
  assert.deepEqual(path(graph, 2, 3, edges), [2, 3]);
  assert.deepEqual(path(graph, 3, 3, edges), [3], "a node reaches itself");
  assert.deepEqual(path(graph, 0, 4, edges), [], "an isolated node is unreachable");
  assert.deepEqual(path(graph, 3, 0, edges), [], "edges are directed");
  assert.deepEqual(path(graph, 9, 0, edges), []);
  assert.deepEqual(path(graph, 0, -1, edges), []);
  for (const [a, b] of [
    [0, 3],
    [2, 3],
    [3, 3],
    [0, 4],
    [3, 0],
  ])
    assert.deepEqual(path(graph, a, b, edges), reference(graph, a, b, edges));
  // Reusing the scratch buffers across calls must not leak one search into the next.
  assert.deepEqual(path(graph, 0, 3, edges), [0, 1, 3]);
  assert.deepEqual(path(graph, 0, 4, edges), []);
});
