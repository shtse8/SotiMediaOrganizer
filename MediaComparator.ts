import type {
  DeduplicationResult,
  FileInfo,
  FrameInfo,
  ProgramOptions,
} from "./types";
import { VPTree } from "./VPTree";

interface IndexedFrame<T> {
  node: T;
  frameIndex: number;
  hash: Buffer;
  timestamp: number;
}
export class MediaComparator {
  constructor(private options: ProgramOptions) {}

  private hammingDistance(hash1: Buffer, hash2: Buffer): number {
    let distance = 0;
    for (let i = 0; i < hash1.length; i++) {
      distance += this.popcount(hash1[i] ^ hash2[i]);
    }
    return distance;
  }

  private popcount(x: number): number {
    x -= (x >> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
    x = (x + (x >> 4)) & 0x0f0f0f0f;
    x += x >> 8;
    x += x >> 16;
    return x & 0x7f;
  }

  deduplicateFiles<T>(
    files: T[],
    selector: (node: T) => FileInfo,
  ): DeduplicationResult<T> {
    const uniqueFiles = new Set<T>();
    const duplicateSets: Array<{
      bestFile: T;
      representatives: Set<T>;
      duplicates: Set<T>;
    }> = [];

    const clusters = this.cluster(files, selector);

    clusters.forEach((cluster) => {
      if (cluster.length === 1) {
        uniqueFiles.add(cluster[0]);
        return;
      }

      const representatives = this.selectRepresentatives(cluster, selector);
      const representativeSet = new Set(representatives);
      const duplicateSet = new Set(
        cluster.filter((file) => !representativeSet.has(file)),
      );

      duplicateSets.push({
        bestFile: representatives[0],
        representatives: representativeSet,
        duplicates: duplicateSet,
      });
    });

    return <DeduplicationResult<T>>{ uniqueFiles, duplicateSets };
  }

  selectRepresentatives<T>(cluster: T[], selector: (node: T) => FileInfo): T[] {
    const sortedEntries = this.sortEntries(cluster, selector);
    const bestEntry = sortedEntries[0];
    const bestFileInfo = selector(bestEntry);

    if (bestFileInfo.effectiveFrames === 1) {
      return [bestEntry];
    } else {
      return this.handleMultiFrameBest(sortedEntries, selector);
    }
  }

  private handleMultiFrameBest<T>(
    sortedEntries: T[],
    selector: (node: T) => FileInfo,
  ): T[] {
    const bestEntry = sortedEntries[0];
    const bestFileInfo = selector(bestEntry);
    const representatives: T[] = [bestEntry];

    const potentialCaptures = sortedEntries.filter((entry) => {
      const fileInfo = selector(entry);
      return (
        fileInfo.effectiveFrames === 1 &&
        (fileInfo.quality || 0) >= (bestFileInfo.quality || 0) &&
        (!bestFileInfo.imageDate || !!fileInfo.imageDate)
      );
    });

    if (potentialCaptures.length > 0) {
      const { uniqueFiles } = this.deduplicateFiles(
        potentialCaptures,
        selector,
      );
      representatives.push(...uniqueFiles);
    }

    return representatives;
  }

  private sortEntries<T>(entries: T[], selector: (node: T) => FileInfo): T[] {
    return entries.sort((a, b) => {
      const aInfo = selector(a);
      const bInfo = selector(b);

      // 1. Prioritize files with longer effective frames
      if (aInfo.effectiveFrames !== bInfo.effectiveFrames) {
        return bInfo.effectiveFrames - aInfo.effectiveFrames;
      }

      // 2. Prioritize files with longer duration
      if (aInfo.duration !== bInfo.duration) {
        return bInfo.duration - aInfo.duration;
      }

      // 3. Prioritize files with image date
      if (!!aInfo.imageDate !== !!bInfo.imageDate) {
        return aInfo.imageDate ? -1 : 1;
      }

      // 4. Prioritize files with image geo
      if (!!aInfo.geoLocation !== !!bInfo.geoLocation) {
        return aInfo.geoLocation ? -1 : 1;
      }

      // 5. Prioritize files with image camera model
      if (!!aInfo.cameraModel !== !!bInfo.cameraModel) {
        return aInfo.cameraModel ? -1 : 1;
      }

      // 6. Prioritize files with high quality
      if (aInfo.quality !== bInfo.quality) {
        return bInfo.quality - aInfo.quality;
      }

      // 7. Prioritize files with larger size
      if (aInfo.size !== bInfo.size) {
        return bInfo.size - aInfo.size;
      }

      return 0;
    });
  }

  cluster<T>(nodes: T[], selector: (node: T) => FileInfo): T[][] {
    const indexedFrames = this.createIndexedFrames(nodes, selector);
    const vpTree = new VPTree<IndexedFrame<T>>(
      indexedFrames,
      (frame) => frame.hash,
      this.hammingDistance.bind(this),
    );

    const similarityMap = new Map<T, Set<T>>();
    nodes.forEach((node) => {
      const similarNodes = this.findSimilarNodes(node, selector, vpTree);
      similarityMap.set(node, new Set(similarNodes));
    });

    const clusters: T[][] = [];
    const processedNodes = new Set<T>();

    nodes.forEach((node) => {
      if (!processedNodes.has(node)) {
        const cluster = this.expandCluster(node, similarityMap, processedNodes);
        clusters.push(cluster);
      }
    });

    return clusters;
  }

  private createIndexedFrames<T>(
    nodes: T[],
    selector: (node: T) => FileInfo,
  ): IndexedFrame<T>[] {
    const indexedFrames: IndexedFrame<T>[] = [];
    nodes.forEach((node) => {
      const fileInfo = selector(node);
      fileInfo.frames.forEach((frame, frameIndex) => {
        indexedFrames.push({
          node,
          frameIndex,
          hash: frame.hash,
          timestamp: frame.timestamp,
        });
      });
    });
    return indexedFrames;
  }

  private compareVideos(video1: FileInfo, video2: FileInfo): number {
    const windowSize = Math.min(
      video1.frames.length,
      video2.frames.length,
      this.options.windowSize,
    );
    let bestSimilarity = 0;

    for (let i = 0; i <= video1.frames.length - windowSize; i++) {
      for (let j = 0; j <= video2.frames.length - windowSize; j++) {
        const window1 = video1.frames.slice(i, i + windowSize);
        const window2 = video2.frames.slice(j, j + windowSize);
        const similarity = 1 - this.dtwDistance(window1, window2) / windowSize;
        bestSimilarity = Math.max(bestSimilarity, similarity);
      }
    }

    return bestSimilarity;
  }

  private dtwDistance(seq1: FrameInfo[], seq2: FrameInfo[]): number {
    const m = seq1.length;
    const n = seq2.length;
    const dtw: number[][] = Array(m + 1)
      .fill(null)
      .map(() => Array(n + 1).fill(Infinity));
    dtw[0][0] = 0;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = this.hammingDistance(seq1[i - 1].hash, seq2[j - 1].hash);
        dtw[i][j] =
          cost + Math.min(dtw[i - 1][j], dtw[i][j - 1], dtw[i - 1][j - 1]);
      }
    }

    return dtw[m][n];
  }

  private findSimilarNodes<T>(
    node: T,
    selector: (node: T) => FileInfo,
    vpTree: VPTree<IndexedFrame<T>>,
  ): T[] {
    const fileInfo = selector(node);
    const similarNodes = new Set<T>();
    const frameThreshold = Math.ceil(
      fileInfo.frames.length * this.options.similarity,
    );

    fileInfo.frames.forEach((frame) => {
      const neighbors = vpTree.nearestNeighbors(frame.hash, {
        distance:
          this.options.resolution *
          this.options.resolution *
          (1 - this.options.similarity),
      });

      neighbors.forEach((neighbor) => {
        if (neighbor.node.node !== node) {
          const neighborNode = neighbor.node.node;
          similarNodes.add(neighborNode);
        }
      });
    });

    return Array.from(similarNodes).filter((similarNode) => {
      const similarFileInfo = selector(similarNode);
      const matchingFrames = this.countMatchingFrames(
        fileInfo,
        similarFileInfo,
      );
      return matchingFrames >= frameThreshold;
    });
  }

  private countMatchingFrames(
    fileInfo1: FileInfo,
    fileInfo2: FileInfo,
  ): number {
    let matchingFrames = 0;
    const maxFrames = Math.max(
      fileInfo1.frames.length,
      fileInfo2.frames.length,
    );

    for (let i = 0; i < maxFrames; i++) {
      const frame1 =
        fileInfo1.frames[Math.floor((i * fileInfo1.frames.length) / maxFrames)];
      const frame2 =
        fileInfo2.frames[Math.floor((i * fileInfo2.frames.length) / maxFrames)];

      if (frame1 && frame2) {
        const distance = this.hammingDistance(frame1.hash, frame2.hash);
        if (
          distance <=
          this.options.resolution *
            this.options.resolution *
            (1 - this.options.similarity)
        ) {
          matchingFrames++;
        }
      }
    }

    return matchingFrames;
  }

  private expandCluster<T>(
    node: T,
    similarityMap: Map<T, Set<T>>,
    processedNodes: Set<T>,
  ): T[] {
    const cluster: T[] = [node];
    const queue: T[] = [node];
    processedNodes.add(node);

    while (queue.length > 0) {
      const currentNode = queue.shift()!;
      const similarNodes = similarityMap.get(currentNode) || new Set();

      similarNodes.forEach((similarNode) => {
        if (!processedNodes.has(similarNode)) {
          cluster.push(similarNode);
          queue.push(similarNode);
          processedNodes.add(similarNode);
        }
      });
    }

    return cluster;
  }
}
