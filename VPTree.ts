interface VPNode<T> {
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
  private root: VPNode<T> | null = null;

  constructor(
    points: T[],
    private distance: (a: T, b: T) => number,
  ) {
    this.root = this.buildSubtree(points);
  }

  private buildSubtree(points: T[]): VPNode<T> | null {
    if (points.length === 0) return null;

    const vantagePointIndex = Math.floor(Math.random() * points.length);
    const vantagePoint = points[vantagePointIndex];
    points[vantagePointIndex] = points[points.length - 1];
    points.pop();

    if (points.length === 0) {
      return { point: vantagePoint, threshold: 0, left: null, right: null };
    }

    const distances = points.map((p) => this.distance(vantagePoint, p));
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
      left: this.buildSubtree(leftPoints),
      right: this.buildSubtree(rightPoints),
    };
  }

  private quickSelect(arr: number[], k: number): number {
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

  search(query: T, options: SearchOptions = {}): SearchResult<T>[] {
    const k = options.k ?? Infinity;
    const maxDistance = options.maxDistance ?? Infinity;
    const sort = options.sort ?? true;

    if (k === 0 || maxDistance === 0) {
      return [];
    }

    let results: SearchResult<T>[] = [];
    this.searchTree(this.root, query, maxDistance, results);

    if (sort) {
      results.sort((a, b) => a.distance - b.distance);
    }

    if (k < Infinity && results.length > k) {
      results = results.slice(0, k);
    }

    return results;
  }

  private searchTree(
    node: VPNode<T> | null,
    query: T,
    maxDistance: number,
    results: SearchResult<T>[],
  ): void {
    if (node === null) return;

    const dist = this.distance(query, node.point);

    if (dist <= maxDistance) {
      results.push({ point: node.point, distance: dist });
    }

    const distLowerBound = dist - maxDistance;
    const distUpperBound = dist + maxDistance;

    if (distLowerBound <= node.threshold) {
      this.searchTree(node.left, query, maxDistance, results);
    }

    if (distUpperBound >= node.threshold) {
      this.searchTree(node.right, query, maxDistance, results);
    }
  }
}
