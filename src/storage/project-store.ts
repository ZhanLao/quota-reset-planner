import { openDB, type IDBPDatabase } from "idb";
import { PlannerError } from "../domain/errors";
import type { PlannerInput, ProjectEnvelope } from "../domain/types";
import { validatePlannerInput } from "../domain/validation";

const DATABASE_NAME = "quota-reset-planner";
const STORE_NAME = "projects";
const ACTIVE_KEY = "active";
let memoryFallback: ProjectEnvelope | null = null;

async function database(): Promise<IDBPDatabase> {
  return openDB(DATABASE_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    }
  });
}

export function createEnvelope(input: PlannerInput): ProjectEnvelope {
  return {
    schemaVersion: 1,
    inputRevision: 1,
    updatedAt: new Date().toISOString(),
    input
  };
}

export async function loadProject(): Promise<{ project: ProjectEnvelope | null; persistent: boolean }> {
  try {
    const db = await database();
    const project = await db.get(STORE_NAME, ACTIVE_KEY) as ProjectEnvelope | undefined;
    return { project: project ?? null, persistent: true };
  } catch {
    return { project: memoryFallback, persistent: false };
  }
}

export async function saveProject(project: ProjectEnvelope): Promise<boolean> {
  memoryFallback = project;
  try {
    const db = await database();
    await db.put(STORE_NAME, project, ACTIVE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function exportProject(project: ProjectEnvelope): void {
  const data = JSON.stringify(project, null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `quota-planner-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function importProject(file: File): Promise<ProjectEnvelope> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new PlannerError("SCHEMA_UNSUPPORTED", "文件不是有效的 JSON，当前项目未被覆盖。");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new PlannerError("SCHEMA_UNSUPPORTED", "文件缺少项目对象，当前项目未被覆盖。");
  }
  const candidate = parsed as Partial<ProjectEnvelope>;
  if (candidate.schemaVersion !== 1 || !candidate.input || candidate.input.schemaVersion !== 1) {
    throw new PlannerError("SCHEMA_UNSUPPORTED", "只支持 schemaVersion=1 的项目文件，当前项目未被覆盖。");
  }
  const issues = validatePlannerInput(candidate.input);
  if (issues.length) {
    throw new PlannerError(
      "INPUT_INVALID",
      "导入文件中的参数无效，当前项目未被覆盖。",
      issues.map((issue) => `${issue.path}: ${issue.message}`)
    );
  }
  return {
    schemaVersion: 1,
    inputRevision: Number.isInteger(candidate.inputRevision) ? candidate.inputRevision as number : 1,
    updatedAt: new Date().toISOString(),
    input: candidate.input,
    lastResult: candidate.lastResult
  };
}
