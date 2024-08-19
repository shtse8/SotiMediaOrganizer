import { Injectable } from "@tsed/di";

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
  media: AdaptiveExtractionJobResult;
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

export interface ProgramOptions {
  error?: string;
  duplicate?: string;
  debug?: string;
  concurrency: number;
  move: boolean;
  resolution: number;
  fps: number;
  maxFrames: number;
  format: string;
  windowSize: number;
  stepSize: number;
  sceneChangeThreshold: number;
  maxChunkSize: number;

  // similarity
  imageSimilarityThreshold: number;
  imageVideoSimilarityThreshold: number;
  videoSimilarityThreshold: number;
}

export class AdaptiveExtractionConfig {
  readonly maxFrames: number;
  readonly sceneChangeThreshold: number;
  readonly resolution: number;
}

@Injectable()
export class FeatureExtractionConfig {
  colorHistogramBins: number;
  edgeDetectionThreshold: number;
}

export class SimilarityConfig {
  windowSize: number;
  stepSize: number;
  readonly fps: number;
  imageSimilarityThreshold: number;
  imageVideoSimilarityThreshold: number;
  videoSimilarityThreshold: number;
}

export class JobConfig {
  adaptiveExtraction: AdaptiveExtractionConfig;
  featureExtraction: FeatureExtractionConfig;
  similarity: SimilarityConfig;
}

export class AdaptiveExtractionJobResult {
  frames: FrameInfo[];
  duration: number;
}

export class FrameInfo {
  hash: Buffer;
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
  hash: Buffer;
  size: number;
  createdAt: Date;
  modifiedAt: Date;
}
