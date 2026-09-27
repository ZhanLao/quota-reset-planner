/// <reference lib="webworker" />
import { PlannerError } from "../domain/errors";
import type { WorkerRequest, WorkerResponse } from "../domain/types";
import { solvePlanner } from "./solve";

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type !== "solve") return;
  try {
    const result = await solvePlanner(event.data.input, event.data.inputRevision, (progress) => {
      const message: WorkerResponse = { type: "progress", progress };
      workerScope.postMessage(message);
    });
    const message: WorkerResponse = { type: "result", result };
    workerScope.postMessage(message);
  } catch (error) {
    const plannerError = error instanceof PlannerError
      ? error
      : new PlannerError("INPUT_INVALID", error instanceof Error ? error.message : String(error));
    const message: WorkerResponse = {
      type: "error",
      code: plannerError.code,
      message: plannerError.message,
      details: plannerError.details
    };
    workerScope.postMessage(message);
  }
};

export {};
