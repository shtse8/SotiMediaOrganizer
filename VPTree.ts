class VPNode {
    constructor(
      public vp: { hash: string, path: string },
      public threshold: number = 0,
      public left: VPNode | null = null,
      public right: VPNode | null = null
    ) {}
  }
  
  export class VPTree {
    private root: VPNode | null = null;
  
    constructor(points: { hash: string, path: string }[], private distance: (a: string, b: string) => number) {
      this.root = this.buildTree(points);
    }
  
    private buildTree(points: { hash: string, path: string }[]): VPNode | null {
      if (points.length === 0) return null;
      const vpIndex = Math.floor(Math.random() * points.length);
      const vp = points[vpIndex];
      points.splice(vpIndex, 1);
  
      if (points.length === 0) return new VPNode(vp);
  
      const median = Math.floor(points.length / 2);
      const distances = points.map(p => this.distance(vp.hash, p.hash));
      const sortedPoints = points.map((p, i) => ({ point: p, distance: distances[i] }))
                                 .sort((a, b) => a.distance - b.distance);
      
      const threshold = sortedPoints[median].distance;
      const leftPoints = sortedPoints.slice(0, median).map(p => p.point);
      const rightPoints = sortedPoints.slice(median).map(p => p.point);
  
      return new VPNode(
        vp,
        threshold,
        this.buildTree(leftPoints),
        this.buildTree(rightPoints)
      );
    }
  
    nearestNeighbors(query: string, k: number): { hash: string, path: string }[] {
      const neighbors: { point: { hash: string, path: string }, distance: number }[] = [];
      this.search(this.root, query, k, neighbors);
      return neighbors.sort((a, b) => a.distance - b.distance).map(n => n.point);
    }
  
    private search(node: VPNode | null, query: string, k: number, neighbors: { point: { hash: string, path: string }, distance: number }[]) {
      if (!node) return;
  
      const d = this.distance(query, node.vp.hash);
      if (neighbors.length < k || d < neighbors[neighbors.length - 1].distance) {
        neighbors.push({ point: node.vp, distance: d });
        neighbors.sort((a, b) => a.distance - b.distance);
        if (neighbors.length > k) neighbors.pop();
      }
  
      if (node.left && (neighbors.length < k || Math.abs(d - node.threshold) < neighbors[neighbors.length - 1].distance)) {
        this.search(node.left, query, k, neighbors);
      }
  
      if (node.right && (neighbors.length < k || Math.abs(d - node.threshold) < neighbors[neighbors.length - 1].distance)) {
        this.search(node.right, query, k, neighbors);
      }
    }
  }