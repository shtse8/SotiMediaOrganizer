  export interface FileInfo {
    path: string;
    size: number;
    hash: string;
    perceptualHash?: string;
    imageDate?: Date;
    fileDate: Date;
    quality?: number;
    geoLocation?: string; 
    cameraModel?: string;
  }
  
  export interface DuplicateSet {
    bestFile: FileInfo;
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
  }

  export interface GatherFileInfoResult {
    fileInfoMap: Map<string, FileInfo>;
    errorFiles: string[];
  }
  
  export interface DeduplicationResult {
    uniqueFiles: Map<string, FileInfo>;
    duplicateSets: Map<string, DuplicateSet>;
  }