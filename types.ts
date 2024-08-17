export interface FileInfo {
  path: string;
  size: number;
  hash: Buffer;
  perceptualHash?: Buffer;
  imageDate?: Date;
  fileDate: Date;
  quality?: number;
  geoLocation?: string;
  cameraModel?: string;
}

export interface DuplicateSet {
  bestFile: string;
  duplicates: Set<string>;
}

export interface ProgramOptions {
  source: string[];
  target: string;
  error?: string;
  duplicate?: string;
  debug?: string;
  concurrency: string;
  move: boolean;
  resolution: string;
  frameCount: string;
  similarity: string;
  format: string;
}

export interface Stats {
  totalCount: number;
  processedCount: number;
  withGeoCount: number;
  withImageDateCount: number;
  withCameraCount: number;
  errorCount: number;
  cachedCount: number;
}

export interface GatherFileInfoResult {
  validFiles: string[];
  errorFiles: string[];
}

export interface DeduplicationResult {
  uniqueFiles: Set<string>;
  duplicateSets: Map<string, DuplicateSet>;
}
