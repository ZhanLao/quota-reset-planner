import { PlannerError } from "../domain/errors";
import type { PlannerInput, ProjectEnvelope } from "../domain/types";
import { validatePlannerInput } from "../domain/validation";

interface LegacyEnvelope {
  schemaVersion: 1;
  inputRevision?: number;
  input: {
    schemaVersion: 1;
    timezone: string;
    horizonStart: string;
    horizonEnd: string;
    quota: {
      capacity: number;
      initialBalance: number;
      nextNaturalResetAt: string;
      cycleHours: number;
      fullUseDays: number;
      sensitivityDays: number[];
    };
    cards: PlannerInput["cards"];
    tasks: Array<{
      id: string;
      name: string;
      availableAt: string;
      deadlineAt: string;
      quotaDemand: number;
      valuePerQuota: number;
      note?: string;
    }>;
    eventGroups: PlannerInput["eventGroups"];
    options: PlannerInput["options"];
  };
}

export interface MigrationResult {
  project: ProjectEnvelope;
  migrationNotice?: string;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new PlannerError("SCHEMA_UNSUPPORTED", "项目文件缺少有效对象，当前项目未被覆盖。");
  }
  return value as Record<string, unknown>;
}

function validateV2(project: ProjectEnvelope): ProjectEnvelope {
  const issues = validatePlannerInput(project.input);
  if (issues.length) {
    throw new PlannerError(
      "INPUT_INVALID",
      "项目参数无效，当前项目未被覆盖。",
      issues.map((issue) => `${issue.path}: ${issue.message}`)
    );
  }
  return project;
}

export function decodeAndMigrateEnvelope(value: unknown, now = new Date().toISOString()): MigrationResult {
  const candidate = asObject(value);
  if (candidate.schemaVersion === 2) {
    const project = candidate as unknown as ProjectEnvelope;
    if (!project.input || project.input.schemaVersion !== 2) {
      throw new PlannerError("SCHEMA_UNSUPPORTED", "schemaVersion=2 的项目缺少 v2 输入数据。");
    }
    return { project: validateV2(project) };
  }
  if (candidate.schemaVersion !== 1) {
    throw new PlannerError("SCHEMA_UNSUPPORTED", `不支持 schemaVersion=${String(candidate.schemaVersion)} 的项目文件。`);
  }

  const legacy = candidate as unknown as LegacyEnvelope;
  const capacity = legacy.input?.quota?.capacity;
  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new PlannerError("SCHEMA_UNSUPPORTED", "旧项目的满额容量无效，无法安全换算百分比。");
  }
  // 旧版把“一份满额”存成 capacity，新版公开接口统一存百分比。
  // 所有换算集中在迁移入口，业务代码从此只接收 v2，避免到处判断 0.35 还是 35。
  const percent = (amount: number) => amount / capacity * 100;
  const input: PlannerInput = {
    schemaVersion: 2,
    timezone: legacy.input.timezone,
    horizonStart: legacy.input.horizonStart,
    horizonEnd: legacy.input.horizonEnd,
    quota: {
      initialRemainingPercent: percent(legacy.input.quota.initialBalance),
      nextNaturalResetAt: legacy.input.quota.nextNaturalResetAt,
      cycleHours: legacy.input.quota.cycleHours,
      fullUseDays: legacy.input.quota.fullUseDays,
      sensitivityDays: legacy.input.quota.sensitivityDays ?? []
    },
    cards: legacy.input.cards ?? [],
    forcedResets: [],
    tasks: (legacy.input.tasks ?? []).map((task) => ({
      id: task.id,
      name: task.name,
      availableAt: task.availableAt,
      deadlineAt: task.deadlineAt,
      quotaDemandPercent: percent(task.quotaDemand),
      valuePerQuota: task.valuePerQuota,
      note: task.note
    })),
    eventGroups: legacy.input.eventGroups ?? [],
    options: legacy.input.options
  };
  const project: ProjectEnvelope = {
    schemaVersion: 2,
    inputRevision: (Number.isInteger(legacy.inputRevision) ? legacy.inputRevision as number : 0) + 1,
    updatedAt: now,
    input
  };
  return {
    project: validateV2(project),
    migrationNotice: "旧版数据已换算为剩余额度百分比；旧求解结果已失效，请重新计算。"
  };
}
