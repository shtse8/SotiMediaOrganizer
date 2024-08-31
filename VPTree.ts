import { MaybePromise } from "./src/types";

export interface VPNode<T> {
  point: T;
  threshold: number;
  left: VPNode<T> | null;
  right: VPNode<T> | null;
}

interface SearchOptions {
  k?: number;
  maxDistance?: number;
  sort?: boolean;
}

export interface SearchResult<T> {
  point: T;
  distance: number;
}

export class VPTree<T> {
  constructor(
    private root: VPNode<T> | null,
    private distance: (a: T, b: T) => MaybePromise<number>,
  ) {}

  static async build<T>(
    points: T[],
    distance: (a: T, b: T) => MaybePromise<number>,
  ): Promise<VPTree<T>> {
    const root = await VPTree.buildSubtree([...points], distance);
    return new VPTree(root, distance);
  }

  private static async buildSubtree<T>(
    points: T[],
    distance: (a: T, b: T) => MaybePromise<number>,
  ): Promise<VPNode<T> | null> {
    if (points.length === 0) return null;

    const vantagePointIndex = Math.floor(Math.random() * points.length);
    const vantagePoint = points[vantagePointIndex];
    points[vantagePointIndex] = points[points.length - 1];
    points.pop();

    if (points.length === 0) {
      return { point: vantagePoint, threshold: 0, left: null, right: null };
    }

    const distances = await Promise.all(
      points.map((p) => distance(vantagePoint, p)),
    );
    const medianIndex = Math.floor(points.length / 2);
    const threshold = this.quickSelect(distances, medianIndex);

    const leftPoints: T[] = [];
    const rightPoints: T[] = [];

    for (let i = 0; i < points.length; i++) {
      if (distances[i] < threshold) {
        leftPoints.push(points[i]);
      } else {
        rightPoints.push(points[i]);
      }
    }

    return {
      point: vantagePoint,
      threshold,
      left: await this.buildSubtree(leftPoints, distance),
      right: await this.buildSubtree(rightPoints, distance),
    };
  }

  private static quickSelect(arr: number[], k: number): number {
    if (arr.length === 1) return arr[0];

    const pivot = arr[Math.floor(Math.random() * arr.length)];
    const left = arr.filter((x) => x < pivot);
    const equal = arr.filter((x) => x === pivot);
    const right = arr.filter((x) => x > pivot);

    if (k < left.length) {
      return this.quickSelect(left, k);
    } else if (k < left.length + equal.length) {
      return pivot;
    } else {
      return this.quickSelect(right, k - left.length - equal.length);
    }
  }

  async search(
    query: T,
    options: SearchOptions = {},
  ): Promise<SearchResult<T>[]> {
    const k = options.k ?? Infinity;
    const maxDistance = options.maxDistance ?? Infinity;
    const sort = options.sort ?? true;

    if (k === 0 || maxDistance === 0) {
      return [];
    }

    let results: SearchResult<T>[] = [];
    await this.searchTree(this.root, query, maxDistance, results);

    if (sort) {
      results.sort((a, b) => a.distance - b.distance);
    }

    if (k < Infinity && results.length > k) {
      results = results.slice(0, k);
    }

    return results;
  }

  private async searchTree(
    node: VPNode<T> | null,
    query: T,
    maxDistance: number,
    results: SearchResult<T>[],
  ): Promise<void> {
    if (node === null) return;

    const dist = await this.distance(query, node.point);

    if (dist <= maxDistance) {
      results.push({ point: node.point, distance: dist });
    }

    const distLowerBound = dist - maxDistance;
    const distUpperBound = dist + maxDistance;

    if (distLowerBound <= node.threshold) {
      await this.searchTree(node.left, query, maxDistance, results);
    }

    if (distUpperBound >= node.threshold) {
      await this.searchTree(node.right, query, maxDistance, results);
    }
  }

  getRoot(): VPNode<T> | null {
    return this.root;
  }

  static fromRoot<T>(
    root: VPNode<T> | null,
    distance: (a: T, b: T) => Promise<number>,
  ): VPTree<T> {
    return new VPTree(root, distance);
  }
}
