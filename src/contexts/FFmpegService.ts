import { injectable } from "inversify";
import ffmpeg from "fluent-ffmpeg";

@injectable()
export class FFmpegService {
  constructor() {}

  get ffmpeg() {
    return ffmpeg;
  }

  get ffprobe() {
    return ffmpeg.ffprobe;
  }
}
