export enum FileType {
  Video,
  Image,
}

export interface ProcessingConfig {
  resolution: number;
  framesPerSecond: number;
  maxFrames: number;
}

export interface FrameInfo {
  hash: Buffer;
  timestamp: number;
}

export interface FileInfo {
  hash: Buffer;
  size: number;
  frames: FrameInfo[];
  duration: number;
  imageDate?: Date;
  width: number;
  height: number;
  quality: number;
  geoLocation?: string;
  cameraModel?: string;
  processingConfig: ProcessingConfig;
  effectiveFrames: number;
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
  cachedCount: number;
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
}
