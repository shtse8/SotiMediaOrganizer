import { FileInfo } from "./types";
import { Injectable, ProviderScope } from "@tsed/di";
import { AdaptiveExtractionJob } from "./jobs/AdaptiveExtractionJob";
import { MetadataExtractionJob } from "./jobs/MetadataExtractionJob";
import { FileStatsJob } from "./jobs/FileStatsJob";

@Injectable({
  scope: ProviderScope.SINGLETON,
})
export class MediaProcessor {
  constructor(
    private adaptiveExtractionJob: AdaptiveExtractionJob,
    private metadataExtractionJob: MetadataExtractionJob,
    private fileStatsJob: FileStatsJob,
  ) {}

  private _cached = new Map<string, FileInfo>();

  async processFile(filePath: string): Promise<FileInfo> {
    if (this._cached.has(filePath)) {
      return this._cached.get(filePath)!;
    }

    const result = await this.process(filePath);
    this._cached.set(filePath, result);
    return result;
  }

  async process(filePath: string): Promise<FileInfo> {
    const [media, metadata, fileStats] = await Promise.all([
      this.adaptiveExtractionJob.process(filePath),
      this.metadataExtractionJob.process(filePath),
      this.fileStatsJob.process(filePath),
    ]);

    return {
      media,
      metadata,
      fileStats,
    };
  }

  exportCache(): Map<string, FileInfo> {
    return this._cached;
  }

  importCache(cache: Map<string, FileInfo>) {
    this._cached = cache;
  }
}
