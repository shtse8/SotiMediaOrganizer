import { AdaptiveExtractionConfig, MediaInfo, FileType } from "../types";
import { FileHashBaseJob } from "./FileHashBaseJob";
import { MediaProcessor } from "../MediaProcessor";
import { Injectable, ProviderScope } from "@tsed/di";
import { MediaOrganizer } from "../../MediaOrganizer";

@Injectable({
  scope: ProviderScope.SINGLETON,
})
export class AdaptiveExtractionJob extends FileHashBaseJob<
  AdaptiveExtractionConfig,
  MediaInfo
> {
  constructor(
    config: AdaptiveExtractionConfig,
    private extractor: MediaProcessor,
  ) {
    super("adaptiveExtraction", config);
  }

  protected async processFile(filePath: string): Promise<MediaInfo> {
    return this.extractor.process(filePath);
  }

  protected isConfigValid(
    filePath: string,
    cachedConfig: AdaptiveExtractionConfig | undefined,
  ): boolean {
    const fileType = MediaOrganizer.getFileType(filePath);
    if (fileType === FileType.Image) {
      // for images, we only need to check the resolution
      return cachedConfig?.resolution === this.config.resolution;
    } else {
      return super.isConfigValid(filePath, cachedConfig);
    }
  }
}
