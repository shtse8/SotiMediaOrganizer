import { type RootDatabase, open } from "lmdb";
import { injectable } from "inversify";

@injectable()
export class DatabaseContext {
  readonly rootDatabase: RootDatabase = open({
    path: ".mediadb",
    compression: true,
  });
  constructor() {}
}
