import { Injectable } from "@tsed/di";
import { Data } from "dataclass";

export enum FileType {
  Video,
  Image,
}

export interface ProcessingConfig {
  resolution: number;
  framesPerSecond: number;
  maxFrames: number;
}

export class FileStatsConfig extends Data {
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
  similarity: number;
  format: string;
  windowSize: number;
  stepSize: number;
  sceneChangeThreshold: number;
  maxChunkSize: number;
}

export class AdaptiveExtractionConfig extends Data {
  readonly maxFrames: number;
  readonly baseFrameRate: number;
  readonly sceneChangeThreshold: number;
  readonly resolution: number;
}

@Injectable()
export class FeatureExtractionConfig extends Data {
  colorHistogramBins: number;
  edgeDetectionThreshold: number;
}

export class SimilarityConfig extends Data {
  similarity: number;
  windowSize: number;
  stepSize: number;
}

export class JobConfig extends Data {
  adaptiveExtraction: AdaptiveExtractionConfig;
  featureExtraction: FeatureExtractionConfig;
  similarity: SimilarityConfig;
}

export class SystemConfig extends Data {
  concurrency: number;
  move: boolean;
  format: string;
}

export class AdaptiveExtractionJobResult extends Data {
  frames: FrameInfo[];
  duration: number;
}

export class FrameInfo extends Data {
  hash: Buffer;
  // data: Buffer;
  // features: Buffer;
  timestamp: number;
}

export class Metadata extends Data {
  width: number;
  height: number;
  gpsLatitude?: number;
  gpsLongitude?: number;
  cameraModel?: string;
  imageDate?: Date;
  get quality(): number {
    return Math.sqrt(this.width * this.height);
  }
}

export class FileStats extends Data {
  hash: Buffer;
  size: number;
  createdAt: Date;
  modifiedAt: Date;
}
