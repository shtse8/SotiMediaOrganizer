import { Mutex } from "async-mutex";
import memoizee from "memoizee";
import { DatabaseContext } from "../contexts/DatabaseContext";
import { Context } from "../contexts/Context";
import type { Database } from "lmdb";
import eql from "deep-eql";

export abstract class BaseFileInfoJob<TConfig, TResult> {
  private readonly getLock = memoizee(() => new Mutex());

  private db: Database;
  private configDb: Database;

  protected get injector() {
    return Context.InjectorService;
  }

  constructor(
    protected readonly dbName: string,
    protected readonly config: TConfig,
  ) {
    const dbContext = this.injector.get(DatabaseContext)!;
    this.db = dbContext.rootDatabase.openDB({ name: this.dbName });
    this.configDb = dbContext.rootDatabase.openDB({
      name: `${this.dbName}_config`,
    });
  }

  async process(filePath: string): Promise<TResult> {
    const cacheKey = await this.getHashKey(filePath);

    return this.getLock(cacheKey).runExclusive(async () => {
      const cachedConfig = await this.configDb.get(cacheKey);
      if (this.isConfigValid(filePath, cachedConfig)) {
        const cachedResult = await this.db!.get(cacheKey);
        if (cachedResult) {
          return cachedResult;
        }
      }

      const result = await this.processFile(filePath);
      await Promise.all([
        this.db.put(cacheKey, result),
        this.configDb!.put(cacheKey, this.config),
      ]);
      return result;
    });
  }

  protected abstract processFile(filePath: string): Promise<TResult>;

  protected isConfigValid(
    filePath: string,
    cachedConfig?: TConfig | undefined,
  ): boolean {
    if (!cachedConfig && !this.config) {
      return true;
    }
    if (!cachedConfig || !this.config) {
      return false;
    }
    return this.isEquivalentConfig(this.config, cachedConfig);
  }

  protected isEquivalentConfig(config1: TConfig, config2: TConfig): boolean {
    return eql(config1, config2);
  }

  protected async getHashKey(filePath: string): Promise<string> {
    return filePath;
  }
}
