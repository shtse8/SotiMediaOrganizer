import { ProviderScope, InjectorService } from "@tsed/di";
import { ExifTool } from "exiftool-vendored";
import {
  AdaptiveExtractionConfig,
  FeatureExtractionConfig,
  SimilarityConfig,
  FileStatsConfig,
  ProgramOptions,
} from "../types";

export class Context {
  private static _injectorService: InjectorService | null;
  private static _isInitialized = false;

  static get injector() {
    if (!Context._injectorService) {
      throw new Error("Context not initialized");
    }
    return Context._injectorService;
  }

  static async ensureInitialized(options: Partial<ProgramOptions> = {}) {
    if (Context._isInitialized) {
      return;
    }
    Context._isInitialized = true;

    const injector = new InjectorService();

    injector.add(ProgramOptions, {
      scope: ProviderScope.SINGLETON,
      useValue: options,
    });

    injector.add(FileStatsConfig, {
      scope: ProviderScope.SINGLETON,
      useValue: <FileStatsConfig>{
        maxChunkSize: options.maxChunkSize || 2 * 1024 * 1024,
      },
    });

    injector.add(AdaptiveExtractionConfig, {
      scope: ProviderScope.SINGLETON,
      useValue: <AdaptiveExtractionConfig>{
        resolution: options.resolution || 64,
        sceneChangeThreshold: options.sceneChangeThreshold || 0.01,
        shortVideoThreshold: options.shortVideoThreshold || 15,
        minFrames: options.minFrames || 15,
        maxSceneFrames: options.maxSceneFrames || 200,
        targetFps: options.targetFps || 0.5,
      },
    });

    injector.add(FeatureExtractionConfig, {
      scope: ProviderScope.SINGLETON,
      useValue: <FeatureExtractionConfig>{
        colorHistogramBins: 16,
        edgeDetectionThreshold: 50,
      },
    });

    injector.add(SimilarityConfig, {
      scope: ProviderScope.SINGLETON,
      useValue: <SimilarityConfig>{
        windowSize: options.windowSize || 5,
        stepSize: options.stepSize || 1,
        imageSimilarityThreshold: options.imageSimilarityThreshold || 0.98,
        imageVideoSimilarityThreshold:
          options.imageVideoSimilarityThreshold || 0.93,
        videoSimilarityThreshold: options.videoSimilarityThreshold || 0.93,
      },
    });

    injector.add(ExifTool, {
      scope: ProviderScope.SINGLETON,
      useFactory: () => new ExifTool(),
    });

    this._injectorService = injector;

    await injector.load();
  }
}
