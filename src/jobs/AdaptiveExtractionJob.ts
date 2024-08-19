import {
  AdaptiveExtractionConfig,
  AdaptiveExtractionJobResult,
  FileType,
} from "../types";
import { FileHashBaseJob } from "./FileHashBaseJob";
import { MediaProcessor } from "../MediaProcessor";
import { Injectable, ProviderScope } from "@tsed/di";
import { MediaOrganizer } from "../../MediaOrganizer";

@Injectable({
  scope: ProviderScope.SINGLETON,
})
export class AdaptiveExtractionJob extends FileHashBaseJob<
  AdaptiveExtractionConfig,
  AdaptiveExtractionJobResult
> {
  constructor(
    config: AdaptiveExtractionConfig,
    private extractor: MediaProcessor,
  ) {
    super("adaptiveExtraction", config);
  }

  protected async processFile(
    filePath: string,
  ): Promise<AdaptiveExtractionJobResult> {
    const [frames, duration] = await Promise.all([
      this.extractor.extractFrames(filePath),
      this.extractor.getDuration(filePath),
    ]);
    return {
      frames,
      duration,
    };
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
