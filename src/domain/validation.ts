import type { PlannerInput, ValidationIssue } from "./types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function instant(value: string): number {
  return Date.parse(value);
}

function isFiniteInstant(value: string): boolean {
  return Number.isFinite(instant(value));
}

export function hasCompleteProbabilities(input: PlannerInput): boolean {
  return input.eventGroups.every((group) => {
    const probabilities = group.outcomes.map((outcome) => outcome.probability);
    return probabilities.every((value) => value !== null) &&
      Math.abs(probabilities.reduce((sum, value) => sum + (value ?? 0), 0) - 1) <= 1e-8;
  });
}

export function scenarioCount(input: PlannerInput): number {
  return input.eventGroups.reduce((count, group) => count * group.outcomes.length, 1);
}

export function validatePlannerInput(input: PlannerInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });
  const start = instant(input.horizonStart);
  const end = instant(input.horizonEnd);

  if (!isFiniteInstant(input.horizonStart)) add("horizonStart", "INVALID_TIME", "规划起点不是有效时刻。");
  if (!isFiniteInstant(input.horizonEnd)) add("horizonEnd", "INVALID_TIME", "规划终点不是有效时刻。");
  if (Number.isFinite(start) && Number.isFinite(end)) {
    if (end <= start) add("horizonEnd", "INVALID_RANGE", "规划终点必须晚于起点。");
    if (end - start > 90 * DAY_MS) add("horizonEnd", "HORIZON_TOO_LONG", "首版单次规划不能超过 90 天。");
  }

  const quota = input.quota;
  if (quota.initialRemainingPercent < 0 || quota.initialRemainingPercent > 100) {
    add("quota.initialRemainingPercent", "INVALID_BALANCE", "当前剩余额度必须位于 0% 与 100% 之间。");
  }
  if (!isFiniteInstant(quota.nextNaturalResetAt)) {
    add("quota.nextNaturalResetAt", "INVALID_TIME", "下一自然重置不是有效时刻。");
  } else if (instant(quota.nextNaturalResetAt) < start) {
    add("quota.nextNaturalResetAt", "PAST_RESET", "下一自然重置不能早于规划起点；请先更新真实账号状态。");
  } else if (quota.cycleHours > 0 && instant(quota.nextNaturalResetAt) > start + quota.cycleHours * HOUR_MS) {
    add("quota.nextNaturalResetAt", "RESET_BEYOND_CYCLE", "下一自然重置超出一个完整周期；请核对真实自然日期和周期单位。");
  }
  if (!(quota.cycleHours > 0)) add("quota.cycleHours", "INVALID_CYCLE", "自然周期必须大于 0。");
  if (!(quota.fullUseDays > 0)) add("quota.fullUseDays", "INVALID_RATE", "用完一份额度所需天数必须大于 0。");
  if (!quota.sensitivityDays.length || quota.sensitivityDays.some((days) => !(days > 0))) {
    add("quota.sensitivityDays", "INVALID_SENSITIVITY", "敏感性天数必须至少包含一个正数。");
  }

  const ids = new Set<string>();
  const claimId = (id: string, path: string) => {
    if (!id.trim()) add(path, "EMPTY_ID", "标识不能为空。");
    if (ids.has(id)) add(path, "DUPLICATE_ID", `标识 ${id} 重复。`);
    ids.add(id);
  };

  input.cards.forEach((card, index) => {
    const path = `cards.${index}`;
    claimId(card.id, `${path}.id`);
    if (!isFiniteInstant(card.availableAt) || !isFiniteInstant(card.expiresAt)) {
      add(path, "INVALID_TIME", "卡片到账或失效时刻无效。");
    } else if (instant(card.expiresAt) <= instant(card.availableAt)) {
      add(`${path}.expiresAt`, "INVALID_RANGE", "卡片失效时刻必须晚于到账时刻。");
    }
  });

  input.forcedResets.forEach((reset, index) => {
    const path = `forcedResets.${index}`;
    claimId(reset.id, `${path}.id`);
    if (!isFiniteInstant(reset.at)) add(`${path}.at`, "INVALID_TIME", "强制重置时刻无效。");
    else if (instant(reset.at) < start || instant(reset.at) >= end) {
      add(`${path}.at`, "RESET_OUTSIDE_HORIZON", "强制重置必须位于规划区间 [起点, 终点) 内。");
    }
  });

  input.tasks.forEach((task, index) => {
    const path = `tasks.${index}`;
    claimId(task.id, `${path}.id`);
    if (!isFiniteInstant(task.availableAt) || !isFiniteInstant(task.deadlineAt)) {
      add(path, "INVALID_TIME", "任务开始或截止时刻无效。");
    } else if (instant(task.deadlineAt) <= instant(task.availableAt)) {
      add(`${path}.deadlineAt`, "INVALID_RANGE", "任务截止时刻必须晚于可开始时刻。");
    }
    if (!(task.quotaDemandPercent > 0)) add(`${path}.quotaDemandPercent`, "INVALID_DEMAND", "任务需求百分比必须大于 0。");
    if (!(task.valuePerQuota >= 1)) add(`${path}.valuePerQuota`, "INVALID_VALUE", "任务价值必须至少为 1。");
  });

  input.eventGroups.forEach((group, groupIndex) => {
    const path = `eventGroups.${groupIndex}`;
    claimId(group.id, `${path}.id`);
    if (group.outcomes.length < 2) add(`${path}.outcomes`, "TOO_FEW_OUTCOMES", "不确定事件至少需要两个互斥结果。");
    let noneCount = 0;
    group.outcomes.forEach((outcome, outcomeIndex) => {
      const outcomePath = `${path}.outcomes.${outcomeIndex}`;
      claimId(outcome.id, `${outcomePath}.id`);
      if (outcome.at === null) noneCount += 1;
      else if (!isFiniteInstant(outcome.at)) add(`${outcomePath}.at`, "INVALID_TIME", "事件时刻无效。");
      else if (instant(outcome.at) < start || instant(outcome.at) >= end) {
        add(`${outcomePath}.at`, "EVENT_OUTSIDE_HORIZON", "事件必须位于规划区间 [起点, 终点) 内。");
      }
      if (outcome.probability !== null && (outcome.probability < 0 || outcome.probability > 1)) {
        add(`${outcomePath}.probability`, "INVALID_PROBABILITY", "概率必须位于 0 与 1 之间。");
      }
    });
    if (noneCount > 1) add(`${path}.outcomes`, "MULTIPLE_NONE", "同一事件组最多只能有一个“不发生”结果。");
    const probabilities = group.outcomes.map((outcome) => outcome.probability);
    if (probabilities.every((value) => value !== null)) {
      const sum = probabilities.reduce((total, value) => total + (value ?? 0), 0);
      if (Math.abs(sum - 1) > 1e-8) add(`${path}.outcomes`, "PROBABILITY_SUM", "同一事件组的概率之和必须为 1。");
    }
  });

  const count = scenarioCount(input);
  if (count > input.options.scenarioLimit || count > 32) {
    add("eventGroups", "SCENARIO_LIMIT", `事件组合会生成 ${count} 个情景，超过上限。`);
  }
  if (![15, 30, 60, 180].includes(input.options.stepMinutes)) {
    add("options.stepMinutes", "INVALID_STEP", "时间步长只能为 15、30、60 或 180 分钟。");
  }
  if (input.options.timeLimitSeconds < 1 || input.options.timeLimitSeconds > 60) {
    add("options.timeLimitSeconds", "INVALID_LIMIT", "求解限时必须位于 1 到 60 秒之间。");
  }
  return issues;
}
