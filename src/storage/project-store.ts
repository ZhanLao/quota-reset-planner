import { openDB, type IDBPDatabase } from "idb";
import { PlannerError } from "../domain/errors";
import type { PlannerInput, ProjectEnvelope } from "../domain/types";
import { decodeAndMigrateEnvelope, type MigrationResult } from "./migrations";

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
    schemaVersion: 2,
    inputRevision: 1,
    updatedAt: new Date().toISOString(),
    input
  };
}

export async function loadProject(): Promise<{ project: ProjectEnvelope | null; persistent: boolean; migrationNotice?: string }> {
  try {
    const db = await database();
    const stored = await db.get(STORE_NAME, ACTIVE_KEY) as unknown;
    if (!stored) return { project: null, persistent: true };
    const migrated = decodeAndMigrateEnvelope(stored);
    if (migrated.migrationNotice) await db.put(STORE_NAME, migrated.project, ACTIVE_KEY);
    return { ...migrated, persistent: true };
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

export async function importProject(file: File): Promise<MigrationResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new PlannerError("SCHEMA_UNSUPPORTED", "文件不是有效的 JSON，当前项目未被覆盖。");
  }
  return decodeAndMigrateEnvelope(parsed);
}
