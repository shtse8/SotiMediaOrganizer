import { Injectable, ProviderScope } from "@tsed/di";
import { type RootDatabase, open } from "lmdb";

@Injectable({
  scope: ProviderScope.SINGLETON,
})
export class DatabaseContext {
  readonly rootDatabase: RootDatabase = open({
    path: ".mediadb",
    compression: true,
  });
  constructor() {}
}
