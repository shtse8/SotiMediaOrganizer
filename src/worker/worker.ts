import "reflect-metadata";

import { MediaComparator } from "../../MediaComparator";
import { WorkerData } from "../types";
import { Context } from "../contexts/Context";
import { MediaProcessor } from "../MediaProcessor";
import workerpool from "workerpool";
import { PerceptualHashWorker } from "./perceptualHashWorker";

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

const perceptualHashWorkerMapper: Map<number, PerceptualHashWorker> = new Map();
function computePerceptualHash(
  imageBuffer: Uint8Array,
  resolution: number,
): Uint8Array {
  let worker = perceptualHashWorkerMapper.get(resolution);
  if (!worker) {
    worker = new PerceptualHashWorker(resolution);
    perceptualHashWorkerMapper.set(resolution, worker);
  }
  return worker.computePerceptualHash(imageBuffer);
}

// Define the worker object with all functions
const worker = {
  performDBSCAN,
  computePerceptualHash,
};

// Infer and export the worker type
export type CustomWorker = typeof worker;

// Expose the worker function
workerpool.worker(worker);
