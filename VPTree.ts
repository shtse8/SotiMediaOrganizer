import { MaxHeap } from "@datastructures-js/heap";

interface VPNode<T> {
  point: T;
  threshold: number;
  left: VPNode<T> | null;
  right: VPNode<T> | null;
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
    const vantagePoint = points.splice(vantagePointIndex, 1)[0];

    if (points.length === 0) {
      return {
        point: vantagePoint,
        threshold: 0,
        left: null,
        right: null,
      };
    }

    const distances = points.map((p) => ({
      point: p,
      distance: this.distance(vantagePoint, p),
    }));

    distances.sort((a, b) => a.distance - b.distance);

    const medianIndex = Math.floor(distances.length / 2);
    const threshold = distances[medianIndex].distance;

    const leftPoints = distances.slice(0, medianIndex).map((d) => d.point);
    const rightPoints = distances.slice(medianIndex).map((d) => d.point);

    return {
      point: vantagePoint,
      threshold,
      left: this.buildSubtree(leftPoints),
      right: this.buildSubtree(rightPoints),
    };
  }

  nearestNeighbors(query: T, options: SearchOptions = {}): SearchResult<T>[] {
    const k = options.k || Infinity;
    const maxDistance = options.distance || Infinity;

    // Use the MaxHeap with a custom comparator based on the distance
    const maxHeap = new MaxHeap<SearchResult<T>>((result) => result.distance);

    this.search(this.root, query, k, maxDistance, maxHeap);

    // Convert the max-heap to an array and return the results sorted by distance
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

    // If the current point is within the distance threshold
    if (dist <= maxDistance) {
      if (maxHeap.size() < k || dist < maxHeap.top()!.distance) {
        maxHeap.push({ node: node.point, distance: dist });

        // If we have more than k results, remove the farthest one
        if (maxHeap.size() > k) {
          maxHeap.pop();
        }
      }
    }

    const { left, right, threshold } = node;

    // Determine which subtree(s) to search
    if (dist < threshold) {
      if (dist - maxDistance <= threshold) {
        this.search(left, query, k, maxDistance, maxHeap);
      }
      if (dist + maxDistance >= threshold) {
        this.search(right, query, k, maxDistance, maxHeap);
      }
    } else {
      if (dist + maxDistance >= threshold) {
        this.search(right, query, k, maxDistance, maxHeap);
      }
      if (dist - maxDistance <= threshold) {
        this.search(left, query, k, maxDistance, maxHeap);
      }
    }
  }
}

interface SearchOptions {
  k?: number;
  distance?: number;
}

export interface SearchResult<T> {
  node: T;
  distance: number;
}
