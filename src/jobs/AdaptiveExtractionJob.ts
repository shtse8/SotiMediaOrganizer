import {
  AdaptiveExtractionConfig,
  AdaptiveExtractionJobResult,
} from "../types";
import { FileHashBaseJob } from "./FileHashBaseJob";
import { AdaptiveExtractor } from "../extractors/AdaptiveExtractor";
import { Injectable } from "@tsed/di";

@Injectable()
export class AdaptiveExtractionJob extends FileHashBaseJob<
  AdaptiveExtractionConfig,
  AdaptiveExtractionJobResult
> {
  constructor(
    config: AdaptiveExtractionConfig,
    private extractor: AdaptiveExtractor,
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
    return AdaptiveExtractionJobResult.create({
      frames,
      duration,
    });
  }
}
