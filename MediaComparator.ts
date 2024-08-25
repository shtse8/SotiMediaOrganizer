import { Injectable, ProviderScope } from "@tsed/di";
import {
  MediaInfo,
  DeduplicationResult,
  FileInfo,
  FrameInfo,
  SimilarityConfig,
  ProgramOptions,
  FileProcessor,
} from "./src/types";
import { cpus } from "os";
import { MediaProcessor } from "./src/MediaProcessor";
import { VPNode, VPTree } from "./VPTree";
import { filterAsync, mapAsync } from "./src/utils";
import { WorkerPool } from "./src/WorkerPool";

@Injectable({
  scope: ProviderScope.SINGLETON,
})
export class MediaComparator {
  private readonly minThreshold: number;

  constructor(
    private mediaProcessor: MediaProcessor,
    private similarityConfig: SimilarityConfig,
    private options: ProgramOptions,
  ) {
    this.minThreshold = Math.min(
      this.similarityConfig.imageSimilarityThreshold,
      this.similarityConfig.imageVideoSimilarityThreshold,
      this.similarityConfig.videoSimilarityThreshold,
    );
  }
  private hammingDistance(
    hash1: SharedArrayBuffer,
    hash2: SharedArrayBuffer,
  ): number {
    const view1 = new Uint32Array(hash1);
    const view2 = new Uint32Array(hash2);
    let distance = 0;

    // Process 32-bit chunks
    for (let i = 0; i < view1.length; i++) {
      distance += this.popcount32(view1[i] ^ view2[i]);
    }

    // Handle remaining bits
    const remainingBytes = new Uint8Array(hash1, view1.length * 4);
    const remainingBytes2 = new Uint8Array(hash2, view2.length * 4);
    for (let i = 0; i < remainingBytes.length; i++) {
      distance += this.popcount32(remainingBytes[i] ^ remainingBytes2[i]);
    }

    return distance;
  }

  private popcount32(x: number): number {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    x += x >>> 8;
    x += x >>> 16;
    return x & 0x3f;
  }

  async deduplicateFiles(
    files: string[],
    selector: FileProcessor,
    progressCallback?: (progress: string) => void,
  ): Promise<DeduplicationResult> {
    progressCallback?.("Building VPTree");
    const vpTree = await VPTree.build(files, async (a, b) => {
      const [fileInfoA, fileInfoB] = await Promise.all([
        selector(a),
        selector(b),
      ]);
      return 1 - this.calculateSimilarity(fileInfoA.media, fileInfoB.media);
    });

    progressCallback?.("Running DBSCAN");
    const clusters = await this.parallelDBSCAN(files, vpTree, progressCallback);

    return this.processResults(clusters, selector);
  }

  private async parallelDBSCAN(
    files: string[],
    vpTree: VPTree<string>,
    progressCallback?: (progress: string) => void,
  ): Promise<Set<string>[]> {
    const batchSize = 500;
    const numWorkers = Math.max(files.length / batchSize, cpus().length - 1);

    const workerPool = new WorkerPool(
      "./src/deduplicationWorker.js",
      numWorkers,
      {
        options: this.options,
        root: vpTree.getRoot(),
        fileInfoCache: this.mediaProcessor.exportCache(),
      },
    );

    workerPool.on("progress", ({ processed, total }) => {
      progressCallback?.("Processed " + processed + " of " + total + " files");
    });

    const results = await workerPool.processInBatches<string, Set<string>[]>(
      files,
      batchSize,
      "dbscan",
    );

    workerPool.terminate();

    return this.mergeAndDeduplicate(results.flat());
  }
  private mergeAndDeduplicate(clusters: Set<string>[]): Set<string>[] {
    const merged: Set<string>[] = [];
    const elementToClusterMap = new Map<string, Set<string>>();

    for (const cluster of clusters) {
      const relatedClusters = new Set<Set<string>>();
      for (const element of cluster) {
        const existingCluster = elementToClusterMap.get(element);
        if (existingCluster) {
          relatedClusters.add(existingCluster);
        }
      }

      if (relatedClusters.size === 0) {
        merged.push(cluster);
        for (const element of cluster) {
          elementToClusterMap.set(element, cluster);
        }
      } else {
        const mergedCluster = new Set<string>(cluster);
        for (const relatedCluster of relatedClusters) {
          for (const element of relatedCluster) {
            mergedCluster.add(element);
          }
          merged.splice(merged.indexOf(relatedCluster), 1);
        }
        merged.push(mergedCluster);
        for (const element of mergedCluster) {
          elementToClusterMap.set(element, mergedCluster);
        }
      }
    }

    return merged;
  }

  async workerDBSCAN(
    chunk: string[],
    vpTree: VPTree<string>,
  ): Promise<Set<string>[]> {
    const eps = 1 - this.minThreshold;
    const minPts = 2;
    const clusters: Set<string>[] = [];
    const visited = new Set<string>();

    for (const point of chunk) {
      if (visited.has(point)) continue;
      visited.add(point);

      const neighbors = await this.getValidNeighbors(point, vpTree, eps);

      if (neighbors.length < minPts) {
        clusters.push(new Set([point]));
        continue;
      }

      const cluster = new Set<string>([point]);
      const stack = [...neighbors];

      while (stack.length > 0) {
        const current = stack.pop()!;
        if (visited.has(current)) continue;
        visited.add(current);

        cluster.add(current);

        const currentNeighbors = await this.getValidNeighbors(
          current,
          vpTree,
          eps,
        );

        if (currentNeighbors.length >= minPts) {
          for (const neighbor of currentNeighbors) {
            if (!visited.has(neighbor)) {
              stack.push(neighbor);
            }
          }
        }
      }

      clusters.push(cluster);
    }

    return clusters;
  }

  private async getValidNeighbors(
    point: string,
    vpTree: VPTree<string>,
    eps: number,
  ): Promise<string[]> {
    const neighbors = await vpTree.search(point, {
      maxDistance: eps,
      sort: false,
    });
    const media1 = (await this.mediaProcessor.processFile(point)).media;
    const result = await filterAsync(neighbors, async (neighbor) => {
      const similarity = 1 - neighbor.distance;
      const media2 = (await this.mediaProcessor.processFile(neighbor.point))
        .media;
      const threshold = this.getAdaptiveThreshold(media1, media2);
      return similarity >= threshold;
    });
    return result.map((n) => n.point);
  }

  private async processResults(
    clusters: Set<string>[],
    selector: FileProcessor,
  ): Promise<DeduplicationResult> {
    const uniqueFiles = new Set<string>();
    const duplicateSets: Array<{
      bestFile: string;
      representatives: Set<string>;
      duplicates: Set<string>;
    }> = [];

    for (const cluster of clusters) {
      if (cluster.size === 1) {
        uniqueFiles.add(cluster.values().next().value);
      } else {
        const clusterArray = Array.from(cluster);
        const representatives = await this.selectRepresentatives(
          clusterArray,
          selector,
        );
        const representativeSet = new Set(representatives);
        const duplicateSet = new Set(
          clusterArray.filter((f) => !representativeSet.has(f)),
        );

        duplicateSets.push({
          bestFile: representatives[0],
          representatives: representativeSet,
          duplicates: duplicateSet,
        });
      }
    }

    return { uniqueFiles, duplicateSets };
  }

  createVPTreeByRoot(root: VPNode<string>): VPTree<string> {
    return new VPTree<string>(root, async (a, b) => {
      const [fileInfoA, fileInfoB] = await Promise.all([
        this.mediaProcessor.processFile(a),
        this.mediaProcessor.processFile(b),
      ]);
      return 1 - this.calculateSimilarity(fileInfoA.media, fileInfoB.media);
    });
  }

  private async selectRepresentatives(
    cluster: string[],
    selector: FileProcessor,
  ): Promise<string[]> {
    if (cluster.length <= 1) return cluster;

    const sortedEntries = await this.scoreEntries(cluster, selector);
    const bestEntry = sortedEntries[0];
    const bestFileInfo = await selector(bestEntry);

    if (bestFileInfo.media.duration === 0) {
      return [bestEntry];
    } else {
      return this.handleMultiFrameBest(sortedEntries, selector);
    }
  }

  private getQuality(fileInfo: FileInfo): number {
    return fileInfo.metadata.width * fileInfo.metadata.height;
  }

  private async handleMultiFrameBest(
    sortedEntries: string[],
    selector: FileProcessor,
  ): Promise<string[]> {
    const bestEntry = sortedEntries[0];
    const bestFileInfo = await selector(bestEntry);
    const representatives: string[] = [bestEntry];

    const potentialCaptures = await filterAsync(
      sortedEntries,
      async (entry) => {
        const fileInfo = await selector(entry);
        return (
          fileInfo.media.duration === 0 &&
          this.getQuality(fileInfo) >= this.getQuality(bestFileInfo) &&
          (!bestFileInfo.metadata.imageDate || !!fileInfo.metadata.imageDate)
        );
      },
    );

    if (potentialCaptures.length > 0) {
      const { uniqueFiles } = await this.deduplicateFiles(
        potentialCaptures,
        selector,
      );
      representatives.push(...uniqueFiles);
    }

    return representatives;
  }

  private async scoreEntries(
    entries: string[],
    selector: FileProcessor,
  ): Promise<string[]> {
    return (
      await mapAsync(entries, async (entry) => ({
        entry,
        score: this.calculateEntryScore(await selector(entry)),
      }))
    )
      .sort((a, b) => b.score - a.score)
      .map((scored) => scored.entry);
  }

  calculateEntryScore(fileInfo: FileInfo): number {
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

  calculateSimilarity(media1: MediaInfo, media2: MediaInfo): number {
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
    const maxDistance = frame1.hash.byteLength * 8;
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

  private getAdaptiveThreshold(media1: MediaInfo, media2: MediaInfo): number {
    const isImage1 = media1.duration === 0;
    const isImage2 = media2.duration === 0;

    if (isImage1 && isImage2)
      return this.similarityConfig.imageSimilarityThreshold;
    if (isImage1 || isImage2)
      return this.similarityConfig.imageVideoSimilarityThreshold;
    return this.similarityConfig.videoSimilarityThreshold;
  }
}
