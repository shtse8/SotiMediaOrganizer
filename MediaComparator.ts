import { Injectable } from "@tsed/di";
import {
  AdaptiveExtractionConfig,
  type DeduplicationResult,
  type FileInfo,
  SimilarityConfig,
} from "./src/types";
import { VPTree } from "./VPTree";
import { AdaptiveExtractor } from "./src/extractors/AdaptiveExtractor";

@Injectable()
export class MediaComparator {
  constructor(
    private extractor: AdaptiveExtractor,
    private similarityConfig: SimilarityConfig,
    private adaptiveExtractionConfig: AdaptiveExtractionConfig,
  ) {}

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

    return { uniqueFiles, duplicateSets };
  }

  private dtwDistance(seq1: Buffer[], seq2: Buffer[]): number {
    const m = seq1.length;
    const n = seq2.length;
    const dtw: number[][] = Array(m + 1)
      .fill(null)
      .map(() => Array(n + 1).fill(Infinity));
    dtw[0][0] = 0;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = this.hammingDistance(seq1[i - 1], seq2[j - 1]);
        dtw[i][j] =
          cost + Math.min(dtw[i - 1][j], dtw[i][j - 1], dtw[i - 1][j - 1]);
      }
    }

    return dtw[m][n];
  }

  selectRepresentatives<T>(cluster: T[], selector: (node: T) => FileInfo): T[] {
    const sortedEntries = this.scoreEntries(cluster, selector);
    const bestEntry = sortedEntries[0];
    const bestFileInfo = selector(bestEntry);

    if (bestFileInfo.media.duration === 0) {
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
        fileInfo.media.duration === 0 &&
        (fileInfo.metadata.quality || 0) >=
          (bestFileInfo.metadata.quality || 0) &&
        (!bestFileInfo.metadata.imageDate || !!fileInfo.metadata.imageDate)
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

  private scoreEntries<T>(entries: T[], selector: (node: T) => FileInfo): T[] {
    const scoredEntries = entries.map((entry) => ({
      entry,
      score: this.calculateEntryScore(selector(entry)),
    }));

    return scoredEntries
      .sort((a, b) => b.score - a.score)
      .map((scored) => scored.entry);
  }

  calculateEntryScore(fileInfo: FileInfo): number {
    let score = 0;

    // Significantly prioritize videos over images
    if (fileInfo.media.duration > 0) {
      score += 10000; // Greatly increased base score for being a video
    }

    // Score for duration (log scale to not overemphasize long durations)
    score += Math.log(fileInfo.media.duration + 1) * 100; // Increased impact of duration

    // Metadata scores
    if (fileInfo.metadata.imageDate) score += 2000; // High importance, but less than being a video
    if (fileInfo.metadata.gpsLatitude && fileInfo.metadata.gpsLongitude)
      score += 300;
    if (fileInfo.metadata.cameraModel) score += 200;

    // Quality score (adjusted to be more representative)
    if (fileInfo.metadata.width && fileInfo.metadata.height) {
      // Assuming quality is width * height
      // This gives 100 points for a 1000x1000 image/video
      score += Math.sqrt(fileInfo.metadata.width * fileInfo.metadata.height);
    }

    // Size score (small bonus for larger files)
    score += Math.log(fileInfo.fileStats.size) * 5;

    return score;
  }

  cluster<T>(nodes: T[], selector: (node: T) => FileInfo): T[][] {
    const vpTree = new VPTree(nodes, (a, b) => {
      const framesA = this.extractor
        .getAdaptiveVideoFrames(
          selector(a).media.frames,
          selector(a).media.duration,
        )
        .map((x) => x.hash);
      const framesB = this.extractor
        .getAdaptiveVideoFrames(
          selector(b).media.frames,
          selector(b).media.duration,
        )
        .map((x) => x.hash);
      return (
        this.dtwDistance(framesA, framesB) /
        Math.max(framesA.length, framesB.length)
      );
    });

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

  private findSimilarNodes<T>(
    node: T,
    selector: (node: T) => FileInfo,
    vpTree: VPTree<T>,
  ): T[] {
    const neighbors = vpTree.nearestNeighbors(node, {
      distance:
        this.adaptiveExtractionConfig.resolution *
        this.adaptiveExtractionConfig.resolution *
        (1 - this.similarityConfig.similarity),
      // distance: this.adaptiveExtractionConfig.resolution * this.adaptiveExtractionConfig.resolution * (1 - this.similarityConfig.similarity),
    });

    return neighbors
      .filter((neighbor) => neighbor.node !== node)
      .map((neighbor) => neighbor.node);
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
