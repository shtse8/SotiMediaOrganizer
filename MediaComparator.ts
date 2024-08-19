import { Injectable, ProviderScope } from "@tsed/di";
import {
  MediaInfo,
  DeduplicationResult,
  FileInfo,
  FrameInfo,
  SimilarityConfig,
} from "./src/types";
import { VPTree } from "./VPTree";

@Injectable({
  scope: ProviderScope.SINGLETON,
})
export class MediaComparator {
  private readonly minThreshold: number;

  constructor(private readonly similarityConfig: SimilarityConfig) {
    this.minThreshold = Math.min(
      this.similarityConfig.imageSimilarityThreshold,
      this.similarityConfig.imageVideoSimilarityThreshold,
      this.similarityConfig.videoSimilarityThreshold,
    );
  }

  private hammingDistance(hash1: Buffer, hash2: Buffer): number {
    let distance = 0;
    const length = Math.min(hash1.length, hash2.length);

    // Process 4 bytes at a time
    for (let i = 0; i < length - 3; i += 4) {
      const xor = (hash1.readUInt32LE(i) ^ hash2.readUInt32LE(i)) >>> 0;
      distance += this.popcount32(xor);
    }

    // Handle remaining bytes
    for (let i = length - (length % 4); i < length; i++) {
      distance += this.popcount8(hash1[i] ^ hash2[i]);
    }

    return distance;
  }

  private popcount32(x: number): number {
    x -= (x >> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
    x = (x + (x >> 4)) & 0x0f0f0f0f;
    x += x >> 8;
    x += x >> 16;
    return x & 0x3f;
  }

  private popcount8(x: number): number {
    x -= (x >> 1) & 0x55;
    x = (x & 0x33) + ((x >> 2) & 0x33);
    x = (x + (x >> 4)) & 0x0f;
    return x;
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

    for (const cluster of clusters) {
      if (cluster.length === 1) {
        uniqueFiles.add(cluster[0]);
        continue;
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
    }

    return { uniqueFiles, duplicateSets };
  }

  private selectRepresentatives<T>(
    cluster: T[],
    selector: (node: T) => FileInfo,
  ): T[] {
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
    return entries
      .map((entry) => ({
        entry,
        score: this.calculateEntryScore(selector(entry)),
      }))
      .sort((a, b) => b.score - a.score)
      .map((scored) => scored.entry);
  }

  public calculateEntryScore(fileInfo: FileInfo): number {
    let score = 0;

    if (fileInfo.media.duration > 0) {
      score += 10000;
    }

    score += Math.log(fileInfo.media.duration + 1) * 100;

    if (fileInfo.metadata.imageDate) score += 2000;
    if (fileInfo.metadata.gpsLatitude && fileInfo.metadata.gpsLongitude)
      score += 300;
    if (fileInfo.metadata.cameraModel) score += 200;

    if (fileInfo.metadata.width && fileInfo.metadata.height) {
      score += Math.sqrt(fileInfo.metadata.width * fileInfo.metadata.height);
    }

    score += Math.log(fileInfo.fileStats.size) * 5;

    return score;
  }

  private calculateSimilarity(media1: MediaInfo, media2: MediaInfo): number {
    const isImage1 = media1.duration === 0;
    const isImage2 = media2.duration === 0;

    if (isImage1 && isImage2) {
      return this.calculateImageSimilarity(media1.frames[0], media2.frames[0]);
    } else if (isImage1 || isImage2) {
      return this.calculateImageVideoSimilarity(
        isImage1 ? media1 : media2,
        isImage1 ? media2 : media1,
      );
    } else {
      return this.calculateVideoSimilarity(media1, media2);
    }
  }

  private calculateImageSimilarity(
    frame1: FrameInfo,
    frame2: FrameInfo,
  ): number {
    const distance = this.hammingDistance(frame1.hash, frame2.hash);
    const maxDistance = frame1.hash.length * 8;
    return 1 - distance / maxDistance;
  }
  private calculateImageVideoSimilarity(
    image: MediaInfo,
    video: MediaInfo,
  ): number {
    if (image.frames.length === 0 || video.frames.length === 0) {
      return 0; // Return 0 similarity if either the image or video has no frames
    }

    const imageFrame = image.frames[0];
    let bestSimilarity = 0;

    for (const videoFrame of video.frames) {
      const similarity = this.calculateImageSimilarity(imageFrame, videoFrame);

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;

        // Early exit if we find a similarity above the threshold
        if (
          bestSimilarity >= this.similarityConfig.imageVideoSimilarityThreshold
        ) {
          return bestSimilarity;
        }
      }
    }

    return bestSimilarity;
  }

  private calculateVideoSimilarity(
    media1: MediaInfo,
    media2: MediaInfo,
  ): number {
    const [shorterMedia, longerMedia] =
      media1.duration <= media2.duration ? [media1, media2] : [media2, media1];

    const windowDuration = shorterMedia.duration;
    const stepSize = this.similarityConfig.stepSize;

    let bestSimilarity = 0;

    for (
      let startTime = 0;
      startTime <= longerMedia.duration - windowDuration;
      startTime += stepSize
    ) {
      const endTime = startTime + windowDuration;

      const longerSubseq = this.getFramesInTimeRange(
        longerMedia,
        startTime,
        endTime,
      );
      const shorterSubseq = shorterMedia.frames;

      const windowSimilarity = this.calculateSequenceSimilarityDTW(
        longerSubseq,
        shorterSubseq,
      );
      bestSimilarity = Math.max(bestSimilarity, windowSimilarity);

      // Early termination if we find a similarity over the threshold
      if (bestSimilarity >= this.similarityConfig.videoSimilarityThreshold)
        break;
    }

    return bestSimilarity;
  }

  private getFramesInTimeRange(
    media: MediaInfo,
    startTime: number,
    endTime: number,
  ): FrameInfo[] {
    return media.frames.filter(
      (frame) => frame.timestamp >= startTime && frame.timestamp <= endTime,
    );
  }

  private calculateSequenceSimilarityDTW(
    seq1: FrameInfo[],
    seq2: FrameInfo[],
  ): number {
    const m = seq1.length;
    const n = seq2.length;
    const dtw: number[] = new Array(n + 1).fill(Infinity);
    dtw[0] = 0;

    for (let i = 1; i <= m; i++) {
      let prev = dtw[0];
      dtw[0] = Infinity;
      for (let j = 1; j <= n; j++) {
        const temp = dtw[j];
        const cost =
          1 - this.calculateImageSimilarity(seq1[i - 1], seq2[j - 1]);
        dtw[j] = cost + Math.min(prev, dtw[j], dtw[j - 1]);
        prev = temp;
      }
    }

    return 1 - dtw[n] / Math.max(m, n);
  }

  cluster<T>(nodes: T[], selector: (node: T) => FileInfo): T[][] {
    const vpTree = new VPTree<T>(
      nodes,
      (a, b) =>
        1 - this.calculateSimilarity(selector(a).media, selector(b).media),
    );

    const clusters: T[][] = [];
    const processedNodes = new Set<T>();

    for (const node of nodes) {
      if (!processedNodes.has(node)) {
        const cluster = this.expandCluster(
          node,
          selector,
          vpTree,
          processedNodes,
        );
        clusters.push(cluster);
      }
    }

    return clusters;
  }

  private findSimilarNodes<T>(
    node: T,
    selector: (node: T) => FileInfo,
    vpTree: VPTree<T>,
  ): T[] {
    return vpTree
      .nearestNeighbors(node, { maxDistance: 1 - this.minThreshold })
      .filter((neighbor) => {
        const similarity = 1 - neighbor.distance;
        const threshold = this.getAdaptiveThreshold(
          selector(node).media,
          selector(neighbor.point).media,
        );
        return similarity >= threshold;
      })
      .map((neighbor) => neighbor.point);
  }

  private getAdaptiveThreshold(media1: MediaInfo, media2: MediaInfo): number {
    const isImage1 = media1.duration === 0;
    const isImage2 = media2.duration === 0;

    if (isImage1 && isImage2)
      return this.similarityConfig.imageSimilarityThreshold;
    if (isImage1 || isImage2)
      return this.similarityConfig.imageVideoSimilarityThreshold;
    return this.similarityConfig.videoSimilarityThreshold;
  }

  private expandCluster<T>(
    node: T,
    selector: (node: T) => FileInfo,
    vpTree: VPTree<T>,
    processedNodes: Set<T>,
  ): T[] {
    const cluster: T[] = [];
    const queue: T[] = [node];
    processedNodes.add(node);

    while (queue.length > 0) {
      const currentNode = queue.shift()!;
      cluster.push(currentNode);

      const similarNodes = this.findSimilarNodes(currentNode, selector, vpTree);
      for (const similarNode of similarNodes) {
        if (!processedNodes.has(similarNode)) {
          queue.push(similarNode);
          processedNodes.add(similarNode);
        }
      }
    }

    return cluster;
  }
}
