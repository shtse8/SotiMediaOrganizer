import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import { AdaptiveExtractionConfig, FileType, FrameInfo } from "./types";
import { Injectable } from "@tsed/di";
import { MediaOrganizer } from "../MediaOrganizer";

@Injectable()
export class MediaProcessor {
  constructor(private config: AdaptiveExtractionConfig) {}

  extractFrames(filePath: string): Promise<FrameInfo[]> {
    const mediaType = MediaOrganizer.getFileType(filePath);
    if (mediaType === FileType.Image) {
      return this.extractImageFrames(filePath);
    } else {
      return this.extractVideoFrames(filePath);
    }
  }

  private async extractImageFrames(imagePath: string): Promise<FrameInfo[]> {
    const image = sharp(imagePath);
    const data = await image
      .resize(this.config.resolution, this.config.resolution, {
        fit: "contain",
      })
      .grayscale()
      .raw()
      .toBuffer();

    const hash = this.computePerceptualHash(data);
    return [FrameInfo.create({ hash, timestamp: 0 })];
  }

  private async extractVideoFrames(videoPath: string): Promise<FrameInfo[]> {
    return this.detectSceneChanges(videoPath);
  }

  public async detectSceneChanges(videoPath: string): Promise<FrameInfo[]> {
    return new Promise((resolve, reject) => {
      const keyFrames: FrameInfo[] = [];
      let currentBuffer: Buffer = Buffer.alloc(0);
      let currentTimestamp: number | null = null;
      const frameSize = this.config.resolution * this.config.resolution; // Size of one grayscale frame

      ffmpeg(videoPath)
        .videoFilters([
          `select='gt(scene,${this.config.sceneChangeThreshold})'`,
          `scale=${this.config.resolution}:${this.config.resolution}:force_original_aspect_ratio=decrease`,
          `pad=width=${this.config.resolution}:height=${this.config.resolution}:x=(ow-iw)/2:y=(oh-ih)/2`,
          "format=gray",
        ])
        .outputOptions(["-f rawvideo", "-pix_fmt gray"])
        .on("stderr", (stderrLine: string) => {
          const match = stderrLine.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
          if (match) {
            const timeInSeconds = this.timeToSeconds(match[1]);
            if (currentTimestamp === null) {
              currentTimestamp = timeInSeconds;
            }
          }
        })
        .on("error", reject)
        .on("end", () => {
          if (currentTimestamp !== null && currentBuffer.length > 0) {
            keyFrames.push(
              FrameInfo.create({
                timestamp: currentTimestamp,
                hash: this.computePerceptualHash(
                  currentBuffer.slice(0, frameSize),
                ),
              }),
            );
          }
          resolve(keyFrames);
        })
        .pipe()
        .on("data", (chunk: Buffer) => {
          currentBuffer = Buffer.concat([currentBuffer, chunk]);

          while (currentBuffer.length >= frameSize) {
            if (currentTimestamp !== null) {
              keyFrames.push(
                FrameInfo.create({
                  timestamp: currentTimestamp,
                  hash: this.computePerceptualHash(
                    currentBuffer.slice(0, frameSize),
                  ),
                }),
              );
              currentTimestamp = null;
            }
            currentBuffer = currentBuffer.slice(frameSize);
          }
        });
    });
  }

  private timeToSeconds(timeString: string): number {
    const [time, fractionalSeconds] = timeString.split(".");
    const [hours, minutes, seconds] = time.split(":").map(Number);

    const totalSeconds = hours * 3600 + minutes * 60 + seconds;
    const milliseconds = Number(fractionalSeconds) / 100;

    return totalSeconds + milliseconds;
  }

  public getAdaptiveVideoFrames(
    keyFrames: FrameInfo[],
    duration: number,
  ): FrameInfo[] {
    return keyFrames;
    const frames: FrameInfo[] = [];
    let nextSceneChange = 0;
    const frameCount = Math.max(
      1,
      Math.ceil(duration * this.config.baseFrameRate),
    );

    for (let i = 0; i < frameCount; i++) {
      const timestamp = (i * duration) / frameCount;
      while (
        nextSceneChange < keyFrames.length - 1 &&
        keyFrames[nextSceneChange].timestamp < timestamp
      ) {
        nextSceneChange++;
      }

      frames.push(
        FrameInfo.create({
          hash: keyFrames[nextSceneChange].hash,
          timestamp: timestamp,
        }),
      );
    }

    return frames;
  }

  private computePerceptualHash(imageBuffer: Buffer): Buffer {
    const pixelCount = this.config.resolution * this.config.resolution;
    const hash = Buffer.alloc(Math.ceil(pixelCount / 8));
    const average =
      imageBuffer.reduce((sum, pixel) => sum + pixel, 0) / pixelCount;

    for (let i = 0; i < pixelCount; i++) {
      if (imageBuffer[i] > average) {
        hash[Math.floor(i / 8)] |= 1 << i % 8;
      }
    }

    return hash;
  }

  async getDuration(filePath: string): Promise<number> {
    const mediaType = MediaOrganizer.getFileType(filePath);
    if (mediaType === FileType.Image) {
      return 0;
    } else {
      return this.getVideoDuration(filePath);
    }
  }

  private async getVideoDuration(videoPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration || 0);
      });
    });
  }
}
