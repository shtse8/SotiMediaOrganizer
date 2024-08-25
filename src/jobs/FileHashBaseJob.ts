import { Context } from "../contexts/Context";
import { sharedArrayBufferToHex } from "../utils";
import { BaseFileInfoJob } from "./BaseFileInfoJob";
import { FileStatsJob } from "./FileStatsJob";

export abstract class FileHashBaseJob<TConfig, TResult> extends BaseFileInfoJob<
  TConfig,
  TResult
> {
  protected async getHashKey(filePath: string): Promise<string> {
    const fileStatsJob = Context.injector.get<FileStatsJob>(FileStatsJob)!;
    const result = await fileStatsJob.process(filePath);
    return sharedArrayBufferToHex(result.hash);
  }
}
