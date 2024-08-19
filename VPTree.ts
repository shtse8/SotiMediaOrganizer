import { MaxHeap } from "@datastructures-js/heap";

interface VPNode<T> {
  point: T;
  threshold: number;
  left: VPNode<T> | null;
  right: VPNode<T> | null;
}

interface SearchOptions {
  k?: number;
  maxDistance?: number;
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

  nearestNeighbors(query: T, options: SearchOptions = {}): SearchResult<T>[] {
    const k = options.k || Infinity;
    const maxDistance = options.maxDistance || Infinity;

    const maxHeap = new MaxHeap<SearchResult<T>>((x) => x.distance);
    this.search(this.root, query, k, maxDistance, maxHeap);

    return maxHeap.sort();
  }

  private search(
    node: VPNode<T> | null,
    query: T,
    k: number,
    maxDistance: number,
    maxHeap: MaxHeap<SearchResult<T>>,
  ): void {
    if (node === null) return;

    const dist = this.distance(query, node.point);

    if (dist <= maxDistance) {
      if (maxHeap.size() < k) {
        maxHeap.push({ point: node.point, distance: dist });
        // Update maxDistance only if we've reached k elements
        if (maxHeap.size() === k) {
          maxDistance = maxHeap.top()!.distance;
        }
      } else if (dist < maxHeap.top()!.distance) {
        maxHeap.pop(); // Remove the farthest before pushing the new point
        maxHeap.push({ point: node.point, distance: dist });
        // Update maxDistance with the new farthest distance
        maxDistance = maxHeap.top()!.distance;
      }
    }

    // Update maxDistance if we have k elements
    if (maxHeap.size() === k) {
      maxDistance = Math.min(maxDistance, maxHeap.top()!.distance);
    }

    const searchBoth =
      maxDistance + dist >= node.threshold &&
      dist - maxDistance <= node.threshold;
    const searchLeft = dist < node.threshold || searchBoth;
    const searchRight = dist >= node.threshold || searchBoth;

    if (searchLeft) this.search(node.left, query, k, maxDistance, maxHeap);
    if (searchRight) this.search(node.right, query, k, maxDistance, maxHeap);
  }

  // New method for range search
  rangeSearch(query: T, radius: number): SearchResult<T>[] {
    const results: SearchResult<T>[] = [];
    this.rangeSearchHelper(this.root, query, radius, results);
    return results.sort((a, b) => a.distance - b.distance);
  }

  private rangeSearchHelper(
    node: VPNode<T> | null,
    query: T,
    radius: number,
    results: SearchResult<T>[],
  ): void {
    if (node === null) return;

    const dist = this.distance(query, node.point);

    if (dist <= radius) {
      results.push({ point: node.point, distance: dist });
    }

    if (dist - radius <= node.threshold) {
      this.rangeSearchHelper(node.left, query, radius, results);
    }
    if (dist + radius >= node.threshold) {
      this.rangeSearchHelper(node.right, query, radius, results);
    }
  }
}
