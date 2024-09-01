import { VPNode } from "../VPTree";

export enum FileType {
  Video,
  Image,
}

export interface ProcessingConfig {
  resolution: number;
  framesPerSecond: number;
  maxFrames: number;
}

export class FileStatsConfig {
  maxChunkSize: number;
}

export interface FileInfo {
  media: MediaInfo;
  // features: Buffer[];
  fileStats: FileStats;
  metadata: Metadata;
}

export interface PathEntry {
  hash: string;
  fileDate: Date;
}

export interface GatherFileInfoResult {
  validFiles: string[];
  errorFiles: string[];
}

export interface DeduplicationResult<T = string> {
  uniqueFiles: Set<T>;
  duplicateSets: DuplicateSet<T>[];
}

export interface DuplicateSet<T = string> {
  bestFile: T;
  representatives: Set<T>;
  duplicates: Set<T>;
}

export interface Stats {
  withGeoCount: number;
  withImageDateCount: number;
  withCameraCount: number;
  errorCount: number;
}

export class ProgramOptions {
  error?: string;
  duplicate?: string;
  debug?: string;
  concurrency: number;
  move: boolean;
  resolution: number;
  format: string;
  windowSize: number;
  stepSize: number;
  maxChunkSize: number;

  // extraction
  minFrames: number;
  maxSceneFrames: number;
  targetFps: number;
  sceneChangeThreshold: number;

  // similarity
  imageSimilarityThreshold: number;
  imageVideoSimilarityThreshold: number;
  videoSimilarityThreshold: number;
}

export class AdaptiveExtractionConfig {
  resolution: number;
  sceneChangeThreshold: number;
  minFrames: number;
  maxSceneFrames: number;
  targetFps: number;
}

export class FeatureExtractionConfig {
  colorHistogramBins: number;
  edgeDetectionThreshold: number;
}

export class SimilarityConfig {
  windowSize: number;
  stepSize: number;
  imageSimilarityThreshold: number;
  imageVideoSimilarityThreshold: number;
  videoSimilarityThreshold: number;
}

export class JobConfig {
  adaptiveExtraction: AdaptiveExtractionConfig;
  featureExtraction: FeatureExtractionConfig;
  similarity: SimilarityConfig;
}

export class MediaInfo {
  frames: FrameInfo[];
  duration: number;
}

export class FrameInfo {
  hash: SharedArrayBuffer;
  // data: Buffer;
  // features: Buffer;
  timestamp: number;
}

export class Metadata {
  width: number;
  height: number;
  gpsLatitude?: number;
  gpsLongitude?: number;
  cameraModel?: string;
  imageDate?: Date;
}

export class FileStats {
  hash: SharedArrayBuffer;
  size: number;
  createdAt: Date;
  modifiedAt: Date;
}

export interface WorkerData {
  root: VPNode<string>;
  fileInfoCache: Map<string, FileInfo>;
  options: ProgramOptions;
}

export type MaybePromise<T> = T | Promise<T>;

export type FileProcessor = (file: string) => Promise<FileInfo>;
