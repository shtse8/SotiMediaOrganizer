import { Injectable, ProviderScope } from "@tsed/di";
import {
  AdaptiveExtractionConfig,
  AdaptiveExtractionJobResult,
  type DeduplicationResult,
  type FileInfo,
  FrameInfo,
  SimilarityConfig,
} from "./src/types";
import { VPTree } from "./VPTree";
import { MediaProcessor } from "./src/MediaProcessor";

@Injectable({
  scope: ProviderScope.SINGLETON,
})
export class MediaComparator {
  private minThreshold: number;

  constructor(
    private extractor: MediaProcessor,
    private similarityConfig: SimilarityConfig,
    private adaptiveExtractionConfig: AdaptiveExtractionConfig,
  ) {
    this.minThreshold = Math.min(
      this.similarityConfig.imageSimilarityThreshold,
      this.similarityConfig.imageVideoSimilarityThreshold,
      this.similarityConfig.videoSimilarityThreshold,
    );
  }

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
    const window = Math.max(this.similarityConfig.windowSize, Math.abs(m - n));

    const dtw: number[][] = Array(m + 1)
      .fill(null)
      .map(() => Array(n + 1).fill(Infinity));
    dtw[0][0] = 0;

    for (let i = 1; i <= m; i++) {
      for (let j = Math.max(1, i - window); j <= Math.min(n, i + window); j++) {
        const cost = this.hammingDistance(seq1[i - 1], seq2[j - 1]);
        dtw[i][j] =
          cost +
          Math.min(
            dtw[i - 1][j], // insertion
            dtw[i][j - 1], // deletion
            dtw[i - 1][j - 1], // match
          );
      }
    }

    // Find the best alignment within the window at the end of the sequences
    let minDistance = Infinity;
    for (let i = Math.max(1, m - window); i <= m; i++) {
      minDistance = Math.min(minDistance, dtw[i][n]);
    }

    return minDistance;
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

  private getQuality(fileInfo: FileInfo): number {
    return fileInfo.metadata.width * fileInfo.metadata.height;
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
        this.getQuality(fileInfo) >= this.getQuality(bestFileInfo) &&
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

  private calculateSimilarity(
    media1: AdaptiveExtractionJobResult,
    media2: AdaptiveExtractionJobResult,
  ): number {
    const isImage1 = media1.duration === 0;
    const isImage2 = media2.duration === 0;

    if (isImage1 && isImage2) {
      // Image to image comparison
      return this.calculateImageSimilarity(media1.frames[0], media2.frames[0]);
    } else if (isImage1 || isImage2) {
      // Image to video comparison
      return this.calculateImageVideoSimilarity(
        isImage1 ? media1 : media2,
        isImage1 ? media2 : media1,
      );
    } else {
      // Video to video comparison
      return this.calculateVideoSimilarity(media1, media2);
    }
  }

  private calculateImageSimilarity(
    frame1: FrameInfo,
    frame2: FrameInfo,
  ): number {
    const distance = this.hammingDistance(frame1.hash, frame2.hash);
    const maxDistance = frame1.hash.length * 8; // Maximum possible Hamming distance
    return 1 - distance / maxDistance;
  }

  private calculateImageVideoSimilarity(
    image: AdaptiveExtractionJobResult,
    video: AdaptiveExtractionJobResult,
  ): number {
    let bestSimilarity = 0;
    for (const frame of video.frames) {
      const similarity = this.calculateImageSimilarity(image.frames[0], frame);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
      }
    }
    return bestSimilarity;
  }

  private calculateVideoSimilarity(
    media1: AdaptiveExtractionJobResult,
    media2: AdaptiveExtractionJobResult,
  ): number {
    const maxDuration = Math.max(media1.duration, media2.duration);
    const minDuration = Math.min(media1.duration, media2.duration);

    let bestSimilarity = 0;
    const windowDuration = Math.min(
      this.similarityConfig.windowSize,
      minDuration,
    );

    // Slide a time window over the longer video
    for (
      let startTime = 0;
      startTime <= maxDuration - windowDuration;
      startTime += this.similarityConfig.stepSize
    ) {
      const endTime = startTime + windowDuration;

      const subseq1 = this.getFramesInTimeRange(media1, startTime, endTime);
      const subseq2 = this.getFramesInTimeRange(media2, startTime, endTime);

      if (subseq1.length > 0 && subseq2.length > 0) {
        const distance = this.dtw(subseq1, subseq2);
        const similarity =
          1 -
          distance /
            (this.adaptiveExtractionConfig.resolution *
              this.adaptiveExtractionConfig.resolution *
              Math.max(subseq1.length, subseq2.length));

        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
        }
      }
    }

    // Adjust similarity based on duration difference
    const durationRatio = minDuration / maxDuration;

    return bestSimilarity * durationRatio;
  }

  private getFramesInTimeRange(
    media: AdaptiveExtractionJobResult,
    startTime: number,
    endTime: number,
  ): FrameInfo[] {
    return media.frames.filter(
      (frame) => frame.timestamp >= startTime && frame.timestamp <= endTime,
    );
  }

  private dtw(seq1: FrameInfo[], seq2: FrameInfo[]): number {
    const m = seq1.length;
    const n = seq2.length;
    const dtw: number[][] = Array(m + 1)
      .fill(null)
      .map(() => Array(n + 1).fill(Infinity));
    dtw[0][0] = 0;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = this.hammingDistance(seq1[i - 1].hash, seq2[j - 1].hash);
        const timeDiff = Math.abs(
          seq1[i - 1].timestamp - seq2[j - 1].timestamp,
        );
        const timeWeight = Math.exp(-timeDiff / this.similarityConfig.stepSize);
        dtw[i][j] =
          cost * timeWeight +
          Math.min(
            dtw[i - 1][j], // insertion
            dtw[i][j - 1], // deletion
            dtw[i - 1][j - 1], // match
          );
      }
    }

    return dtw[m][n];
  }

  cluster<T>(nodes: T[], selector: (node: T) => FileInfo): T[][] {
    const vpTree = new VPTree(nodes, (a, b) => {
      const d =
        1 - this.calculateSimilarity(selector(a).media, selector(b).media);
      // console.log('distance', d);
      return d;
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
      distance: 1 - this.minThreshold,
    });

    return neighbors
      .filter((neighbor) => {
        const similarity = 1 - neighbor.distance;
        const threshold = this.getAdaptiveThreshold(
          selector(node).media,
          selector(neighbor.node).media,
        );
        return similarity >= threshold;
      })
      .map((neighbor) => neighbor.node);
  }

  private getAdaptiveThreshold(
    media1: AdaptiveExtractionJobResult,
    media2: AdaptiveExtractionJobResult,
  ): number {
    const isImage1 = media1.duration === 0;
    const isImage2 = media2.duration === 0;

    if (isImage1 && isImage2) {
      return this.similarityConfig.imageSimilarityThreshold;
    } else if (isImage1 || isImage2) {
      return this.similarityConfig.imageVideoSimilarityThreshold;
    } else {
      return this.similarityConfig.videoSimilarityThreshold;
    }
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
