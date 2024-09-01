import "reflect-metadata";

import { MediaComparator } from "../MediaComparator";
import { WorkerData } from "./types";
import { Context } from "./contexts/Context";
import { MediaProcessor } from "./MediaProcessor";
import workerpool from "workerpool";

async function performDBSCAN(
  workerData: WorkerData,
  chunk: string[],
): Promise<Set<string>[]> {
  const { root, fileInfoCache, options } = workerData;
  const container = Context.createContainer(options);
  const comparator =
    await container.getAsync<MediaComparator>(MediaComparator)!;
  const processor = container.get<MediaProcessor>(MediaProcessor)!;
  processor.importCache(fileInfoCache);
  const vpTree = comparator.createVPTreeByRoot(root);

  return await comparator.workerDBSCAN(chunk, vpTree);
}

// Define the worker object with all functions
const worker = {
  performDBSCAN,
};

// Infer and export the worker type
export type CustomWorker = typeof worker;

// Expose the worker function
workerpool.worker(worker);
