import { Mutex } from "async-mutex";
import memoizee from "memoizee";
import { DatabaseContext } from "../contexts/DatabaseContext";
import { Context } from "../contexts/Context";
import type { Database } from "lmdb";
import eql from "deep-eql";
import { hexToSharedArrayBuffer, sharedArrayBufferToHex } from "../utils";

export abstract class BaseFileInfoJob<TConfig, TResult> {
  private readonly getLock = memoizee(() => new Mutex());

  private db: Database;
  private configDb: Database;

  constructor(
    protected readonly dbName: string,
    protected readonly config: TConfig,
  ) {
    const dbContext = Context.injector.get(DatabaseContext)!;
    this.db = dbContext.rootDatabase.openDB({ name: this.dbName });
    this.configDb = dbContext.rootDatabase.openDB({
      name: `${this.dbName}_config`,
    });
  }

  async process(filePath: string): Promise<TResult> {
    const cacheKey = await this.getHashKey(filePath);

    return this.getLock(cacheKey).runExclusive(async () => {
      const cachedConfig = (await this.configDb.get(cacheKey)) as TConfig;
      if (this.isConfigValid(filePath, cachedConfig)) {
        const cachedResult = (await this.db!.get(cacheKey)) as TResult;
        if (cachedResult) {
          return this.convertFromStorageFormat(cachedResult);
        }
      }

      const result = await this.processFile(filePath);
      await Promise.all([
        this.db.put(cacheKey, this.convertToStorageFormat(result)),
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

  protected convertToStorageFormat(result: TResult): unknown {
    if (result instanceof SharedArrayBuffer) {
      return {
        type: "SharedArrayBuffer",
        data: sharedArrayBufferToHex(result),
      };
    } else if (result instanceof Date) {
      return {
        type: "Date",
        value: result.toISOString(),
      };
    } else if (Array.isArray(result)) {
      return result.map((item) => this.convertToStorageFormat(item));
    } else if (this.isPlainObject(result)) {
      const converted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(
        result as Record<string, unknown>,
      )) {
        converted[key] = this.convertToStorageFormat(value as TResult);
      }
      return converted;
    }
    return result;
  }

  protected convertFromStorageFormat(stored: unknown): TResult {
    if (stored && typeof stored === "object") {
      const storedObj = stored as Record<string, unknown>;
      if (storedObj.type === "SharedArrayBuffer") {
        return hexToSharedArrayBuffer(
          storedObj.data as string,
        ) as unknown as TResult;
      } else if (storedObj.type === "Date") {
        return new Date(storedObj.value as string) as unknown as TResult;
      } else if (Array.isArray(stored)) {
        return (stored as unknown[]).map((item) =>
          this.convertFromStorageFormat(item),
        ) as unknown as TResult;
      } else if (this.isPlainObject(storedObj)) {
        const converted: Record<string, TResult> = {};
        for (const [key, value] of Object.entries(storedObj)) {
          converted[key] = this.convertFromStorageFormat(value);
        }
        return converted as TResult;
      }
    }
    return stored as TResult;
  }

  private isPlainObject(obj: unknown): obj is Record<string, unknown> {
    if (typeof obj !== "object" || obj === null) return false;

    const proto = Object.getPrototypeOf(obj);
    if (proto === null) return true;

    let baseProto = proto;
    while (Object.getPrototypeOf(baseProto) !== null) {
      baseProto = Object.getPrototypeOf(baseProto);
    }

    return proto === baseProto;
  }
}
