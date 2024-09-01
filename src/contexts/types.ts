import type workerpool from "workerpool";
import type { CustomWorker } from "../worker/worker";

export const Types = {
  WorkerPool: Symbol.for("WorkerPool"),
};

export type WorkerPool = workerpool.Proxy<CustomWorker>;
