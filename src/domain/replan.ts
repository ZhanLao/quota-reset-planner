import { PlannerError } from "./errors";
import type { EventGroup, PlannerInput } from "./types";

function keepFutureOutcomes(group: EventGroup, at: number): EventGroup | null {
  const outcomes = group.outcomes.filter((outcome) => outcome.at === null || Date.parse(outcome.at) >= at);
  if (outcomes.length <= 1) return null;
  const probabilitiesKnown = outcomes.every((outcome) => outcome.probability !== null);
  if (!probabilitiesKnown) return { ...group, outcomes };
  // 过去未发生的候选已经被观察排除；已知概率需要在剩余候选上重新归一化。
  const sum = outcomes.reduce((total, outcome) => total + (outcome.probability ?? 0), 0);
  if (sum <= 0) return { ...group, outcomes: outcomes.map((outcome) => ({ ...outcome, probability: null })) };
  return {
    ...group,
    outcomes: outcomes.map((outcome) => ({ ...outcome, probability: (outcome.probability ?? 0) / sum }))
  };
}

export function applyObservedForcedReset(
  input: PlannerInput,
  atIso: string
): PlannerInput {
  const at = Date.parse(atIso);
  const start = Date.parse(input.horizonStart);
  const end = Date.parse(input.horizonEnd);
  if (!Number.isFinite(at) || at < start || at >= end) {
    throw new PlannerError("INPUT_INVALID", "意外重置时刻必须位于当前规划区间 [起点, 终点) 内。");
  }
  const nextNatural = new Date(at + input.quota.cycleHours * 60 * 60 * 1000).toISOString();
  // 这里直接建立“重置后的当前状态”，不把刚发生的事件再次交给求解器执行。
  // 否则起点会先是 100%，又被同一事件覆盖一次，虚构 100% 的覆盖损失。
  return {
    ...structuredClone(input),
    horizonStart: new Date(at).toISOString(),
    quota: {
      ...input.quota,
      initialRemainingPercent: 100,
      nextNaturalResetAt: nextNatural
    },
    cards: input.cards.filter((card) => Date.parse(card.expiresAt) > at),
    forcedResets: input.forcedResets.filter((reset) => Date.parse(reset.at) > at),
    tasks: input.tasks.filter((task) => Date.parse(task.deadlineAt) > at),
    // 过去的不确定分支已经不再影响未来；当前真实余额和自然日期已包含它们的实际后果。
    eventGroups: input.eventGroups
      .map((group) => keepFutureOutcomes(group, at))
      .filter((group): group is EventGroup => group !== null)
  };
}
