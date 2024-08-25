import { parentPort, workerData } from "worker_threads";
import { MediaComparator } from "../MediaComparator";
import { WorkerData } from "./types";
import { Context } from "./contexts/Context";
import { MediaProcessor } from "./MediaProcessor";
import { WorkerMessage, WorkerResponse } from "./WorkerPool";

const { options, root, fileInfoCache } = workerData as WorkerData;

// Initialize the injector with the options passed from the main process
await Context.ensureInitialized(options);

const comparator = Context.injector.get<MediaComparator>(MediaComparator)!;
const processor = Context.injector.get<MediaProcessor>(MediaProcessor)!;
processor.importCache(fileInfoCache);
const vpTree = comparator.createVPTreeByRoot(root);

// how to preseve typing??
parentPort?.on("message", async (message: WorkerMessage) => {
  const { runId, action, data } = message;
  let result: Set<string>[], error: Error;
  try {
    switch (action) {
      case "dbscan":
        result = await performDBSCAN(data as string[]);
        break;
      // Add other actions as needed
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (e) {
    error = e;
  }

  const response: WorkerResponse = { runId, result, error };
  parentPort!.postMessage(response);
});

async function performDBSCAN(chunk: string[]): Promise<Set<string>[]> {
  return await comparator.workerDBSCAN(chunk, vpTree);
}
