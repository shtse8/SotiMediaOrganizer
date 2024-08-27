import { injectable, inject } from "inversify";
import { sharedArrayBufferToHex } from "../utils";
import { BaseFileInfoJob } from "./BaseFileInfoJob";
import { FileStatsJob } from "./FileStatsJob";

@injectable()
export abstract class FileHashBaseJob<
  TResult,
  TConfig = void,
> extends BaseFileInfoJob<TResult, TConfig> {
  @inject(FileStatsJob)
  private readonly fileStatsJob: FileStatsJob;

  protected async getHashKey(filePath: string): Promise<string> {
    const result = await this.fileStatsJob.process(filePath);
    return sharedArrayBufferToHex(result.hash);
  }
}
