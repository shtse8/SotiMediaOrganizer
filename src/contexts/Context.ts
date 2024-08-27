import { Container } from "inversify";
import { ExifTool } from "exiftool-vendored";
import {
  AdaptiveExtractionConfig,
  FeatureExtractionConfig,
  SimilarityConfig,
  FileStatsConfig,
  ProgramOptions,
} from "../types";
import { MediaComparator } from "../../MediaComparator";
import { MediaOrganizer } from "../../MediaOrganizer";
import { MediaProcessor } from "../MediaProcessor";
import { AdaptiveExtractionJob } from "../jobs/AdaptiveExtractionJob";
import { MetadataExtractionJob } from "../jobs/MetadataExtractionJob";
import { FileStatsJob } from "../jobs/FileStatsJob";
import { DatabaseContext } from "./DatabaseService";
import { SharpService } from "./SharpService";
import { FFmpegService } from "./FFmpegService";

export class Context {
  private static _container: Container | null;
  private static _isInitialized = false;

  static get injector() {
    if (!Context._container) {
      throw new Error("Context not initialized");
    }
    return Context._container;
  }

  static async ensureInitialized(options?: ProgramOptions) {
    if (Context._isInitialized) {
      return;
    }
    Context._isInitialized = true;

    const container = new Container();

    // services
    container.bind(SharpService).toSelf().inSingletonScope();
    container.bind(MediaComparator).toSelf().inSingletonScope();
    container.bind(MediaOrganizer).toSelf().inSingletonScope();
    container.bind(MediaProcessor).toSelf().inSingletonScope();
    container.bind(DatabaseContext).toSelf().inSingletonScope();
    container.bind(FFmpegService).toSelf().inSingletonScope();

    // jobs
    container.bind(AdaptiveExtractionJob).toSelf().inSingletonScope();
    container.bind(MetadataExtractionJob).toSelf().inSingletonScope();
    container.bind(FileStatsJob).toSelf().inSingletonScope();

    container.bind(ProgramOptions).toConstantValue(options);
    container.bind(FileStatsConfig).toConstantValue({
      maxChunkSize: options?.maxChunkSize || 2 * 1024 * 1024,
    });
    container.bind(AdaptiveExtractionConfig).toConstantValue({
      resolution: options?.resolution || 64,
      sceneChangeThreshold: options?.sceneChangeThreshold || 0.01,
      shortVideoThreshold: options?.shortVideoThreshold || 15,
      minFrames: options?.minFrames || 15,
      maxSceneFrames: options?.maxSceneFrames || 200,
      targetFps: options?.targetFps || 0.5,
    });
    container.bind(FeatureExtractionConfig).toConstantValue({
      colorHistogramBins: 16,
      edgeDetectionThreshold: 50,
    });
    container.bind(SimilarityConfig).toConstantValue({
      windowSize: options?.windowSize || 5,
      stepSize: options?.stepSize || 1,
      imageSimilarityThreshold: options?.imageSimilarityThreshold || 0.98,
      imageVideoSimilarityThreshold:
        options?.imageVideoSimilarityThreshold || 0.93,
      videoSimilarityThreshold: options?.videoSimilarityThreshold || 0.93,
    });
    container
      .bind(ExifTool)
      .toDynamicValue(
        () =>
          new ExifTool({
            maxProcs: options?.concurrency || 1,
          }),
      )
      .inSingletonScope();

    this._container = container;

    await container.loadAsync();
  }
}
