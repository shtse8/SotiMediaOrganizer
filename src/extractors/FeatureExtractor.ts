import sharp from "sharp";
import { AdaptiveExtractionConfig, FeatureExtractionConfig } from "../types";
import { Injectable } from "@tsed/di";

@Injectable()
export class FeatureExtractor {
  constructor(
    private config: FeatureExtractionConfig,
    private adaptiveExtractionConfig: AdaptiveExtractionConfig,
  ) {}

  async extractFeatures(frameData: Buffer): Promise<Buffer> {
    const image = sharp(frameData, {
      raw: {
        width: this.adaptiveExtractionConfig.resolution,
        height: this.adaptiveExtractionConfig.resolution,
        channels: 1,
      },
    });

    const [colorHistogram, edgeHistogram] = await Promise.all([
      this.computeColorHistogram(image),
      this.computeEdgeHistogram(image),
    ]);

    // Combine histograms and convert to Buffer
    const combinedFeatures = [...colorHistogram, ...edgeHistogram];
    return Buffer.from(new Float32Array(combinedFeatures).buffer);
  }

  private async computeColorHistogram(image: sharp.Sharp): Promise<number[]> {
    const { channels } = await image.stats();
    const histogram: number[] = [];

    for (const channel of channels) {
      const bins = new Array(this.config.colorHistogramBins).fill(0);
      const binSize = 256 / this.config.colorHistogramBins;

      for (let i = 0; i < 256; i++) {
        const binIndex = Math.floor(i / binSize);
        bins[binIndex] += (i - channel.min) / (channel.max - channel.min);
      }

      // Normalize the bins
      const sum = bins.reduce((a, b) => a + b, 0);
      histogram.push(...bins.map((bin) => bin / sum));
    }

    return histogram;
  }

  private async computeEdgeHistogram(image: sharp.Sharp): Promise<number[]> {
    const edgeImage = await image
      .convolve({
        width: 3,
        height: 3,
        kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1],
      })
      .toBuffer();

    const { channels } = await sharp(edgeImage, {
      raw: {
        width: this.adaptiveExtractionConfig.resolution,
        height: this.adaptiveExtractionConfig.resolution,
        channels: 1,
      },
    }).stats();
    const edgeHistogram = new Array(this.config.colorHistogramBins).fill(0);
    const binSize = 256 / this.config.colorHistogramBins;

    for (const channel of channels) {
      for (let i = channel.min; i <= channel.max; i++) {
        const binIndex = Math.floor(i / binSize);
        edgeHistogram[binIndex] +=
          (i - channel.min) / (channel.max - channel.min);
      }
    }

    // Normalize the histogram
    const sum = edgeHistogram.reduce((a, b) => a + b, 0);
    return edgeHistogram.map((bin) => bin / sum);
  }
}
