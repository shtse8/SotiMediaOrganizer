import { MaxHeap } from "@datastructures-js/heap";

interface VPNode {
  vantagePoint: Buffer;
  threshold: number;
  left: VPNode | null;
  right: VPNode | null;
  identifier: string;
}
  
export class VPTree {
    private root: VPNode | null = null;
  
    constructor(points: { hash: Buffer; identifier: string }[], private distance: (a: Buffer, b: Buffer) => number) {
      this.root = this.buildSubtree(points);
    }
  
    private buildSubtree(points: { hash: Buffer; identifier: string }[]): VPNode | null {
        if (points.length === 0) return null;

        const vantagePointIndex = Math.floor(Math.random() * points.length);
        const vantagePoint = points.splice(vantagePointIndex, 1)[0];

        if (points.length === 0) {
            return {
                vantagePoint: vantagePoint.hash,
                threshold: 0,
                left: null,
                right: null,
                identifier: vantagePoint.identifier,
            };
        }

        const distances = points.map((p) => ({
            point: p,
            distance: this.distance(vantagePoint.hash, p.hash),
        }));

        distances.sort((a, b) => a.distance - b.distance);

        const medianIndex = Math.floor(distances.length / 2);
        const threshold = distances[medianIndex].distance;

        const leftPoints = distances.slice(0, medianIndex).map((d) => d.point);
        const rightPoints = distances.slice(medianIndex).map((d) => d.point);

        return {
            vantagePoint: vantagePoint.hash,
            threshold,
            left: this.buildSubtree(leftPoints),
            right: this.buildSubtree(rightPoints),
            identifier: vantagePoint.identifier,
        };
    }
  
    nearestNeighbors(query: Buffer, options: SearchOptions = {}): SearchResult[] {
        const k = options.k || Infinity;
        const maxDistance = options.distance || Infinity;

        // Use the MaxHeap with a custom comparator based on the distance
        const maxHeap = new MaxHeap<SearchResult>((result) => result.distance);

        this.search(this.root, query, k, maxDistance, maxHeap);

        // Convert the max-heap to an array and return the results sorted by distance
        return maxHeap.sort();
    }

    private search(node: VPNode | null, query: Buffer, k: number, maxDistance: number, maxHeap: MaxHeap<SearchResult>): void {
        if (node === null) return;

        const dist = this.distance(query, node.vantagePoint);

        // If the current point is within the distance threshold
        if (dist <= maxDistance) {
            if (maxHeap.size() < k || dist < maxHeap.top()!.distance) {
                maxHeap.push({ identifier: node.identifier, distance: dist });

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

interface SearchResult {
    identifier: string;
    distance: number;
}