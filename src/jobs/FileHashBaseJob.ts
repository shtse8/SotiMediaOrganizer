import { BaseFileInfoJob } from "./BaseFileInfoJob";
import { FileStatsJob } from "./FileStatsJob";

export abstract class FileHashBaseJob<TConfig, TResult> extends BaseFileInfoJob<
  TConfig,
  TResult
> {
  protected async getHashKey(filePath: string): Promise<string> {
    const fileStatsJob = this.injector.get<FileStatsJob>(FileStatsJob)!;
    const result = await fileStatsJob.process(filePath);
    return result.hash.toString("hex");
  }
}
