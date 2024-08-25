import { EventEmitter } from "events";
import { Worker, WorkerOptions } from "worker_threads";
import { randomUUID } from "crypto";
import { WorkerData } from "./types";

export interface WorkerMessage<T = unknown> {
  runId: string;
  action: string;
  data: T;
}

export interface WorkerResponse<T = unknown> {
  runId: string;
  result: T;
  error?: Error;
}

enum WorkerStatus {
  Idle,
  Busy,
}

class ManagedWorker extends EventEmitter {
  private worker: Worker;
  private activeRuns: Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
  > = new Map();
  status: WorkerStatus = WorkerStatus.Idle;

  constructor(filename: string, options?: WorkerOptions) {
    super();
    this.worker = new Worker(filename, options);
    this.worker.on("message", this.handleMessage.bind(this));
    this.worker.on("error", this.handleError.bind(this));
  }

  async run<T = unknown, R = unknown>(action: string, data: T): Promise<R> {
    const runId = randomUUID();
    return new Promise<R>((resolve, reject) => {
      this.activeRuns.set(runId, { resolve, reject });
      const message: WorkerMessage<T> = { runId, action, data };
      this.worker.postMessage(message);
    });
  }

  private handleMessage(response: WorkerResponse<unknown>) {
    const { runId, result, error } = response;
    const run = this.activeRuns.get(runId);
    if (run) {
      if (error) {
        run.reject(error);
      } else {
        run.resolve(result);
      }
      this.activeRuns.delete(runId);
    }
    this.emit("jobCompleted");
  }

  private handleError(error: Error) {
    console.error("Worker error:", error);
    this.emit("error", error);
  }

  terminate() {
    this.worker.terminate();
  }
}

interface Job<T, R> {
  action: string;
  data: T;
  resolve: (value: R) => void;
  reject: (reason: unknown) => void;
}

export class WorkerPool extends EventEmitter {
  private workers: ManagedWorker[] = [];
  private jobQueue: Job<unknown, unknown>[] = [];

  constructor(
    private workerScriptPath: string,
    private numWorkers: number,
    private workerData: WorkerData,
  ) {
    super();
    this.initialize();
  }

  private initialize(): void {
    for (let i = 0; i < this.numWorkers; i++) {
      const worker = new ManagedWorker(this.workerScriptPath, {
        workerData: this.workerData,
      });
      worker.on("jobCompleted", () => this.processNextJob());
      worker.on("error", (error) => this.emit("workerError", error));
      this.workers.push(worker);
    }
  }

  private async runJob<T, R>(
    worker: ManagedWorker,
    job: Job<T, R>,
  ): Promise<void> {
    worker.status = WorkerStatus.Busy;
    try {
      const result = await worker.run<T, R>(job.action, job.data);
      job.resolve(result);
    } catch (error) {
      job.reject(error);
    } finally {
      worker.status = WorkerStatus.Idle;
    }
  }

  private processNextJob(): void {
    const idleWorker = this.workers.find(
      (worker) => worker.status === WorkerStatus.Idle,
    );
    if (idleWorker && this.jobQueue.length > 0) {
      const nextJob = this.jobQueue.shift()!;
      this.runJob(idleWorker, nextJob);
    }
  }

  async addJob<T, R>(action: string, data: T): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const job: Job<T, R> = { action, data, resolve, reject };
      this.jobQueue.push(job);
      this.processNextJob();
    });
  }

  async processInBatches<T, R>(
    items: T[],
    batchSize: number,
    action: string,
  ): Promise<R[]> {
    const totalItems = items.length;
    const results: R[] = [];
    let processedItems = 0;

    for (let i = 0; i < totalItems; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchPromise = this.addJob<T[], R[]>(action, batch);

      batchPromise.then((batchResults) => {
        results.push(...batchResults);
        processedItems += batch.length;
        this.emit("progress", { processed: processedItems, total: totalItems });
      });
    }

    await Promise.all(
      this.workers.map((worker) =>
        worker.status === WorkerStatus.Busy
          ? new Promise((resolve) => worker.once("jobCompleted", resolve))
          : Promise.resolve(),
      ),
    );

    return results;
  }

  terminate(): void {
    this.workers.forEach((worker) => worker.terminate());
    this.workers = [];
    this.jobQueue = [];
  }
}
