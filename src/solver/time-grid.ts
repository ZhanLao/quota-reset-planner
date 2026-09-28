import type { PlannerInput } from "../domain/types";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export function toMs(iso: string): number {
  return Date.parse(iso);
}

export function toIso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

export function buildTimeGrid(input: PlannerInput): number[] {
  const start = toMs(input.horizonStart);
  const end = toMs(input.horizonEnd);
  const step = input.options.stepMinutes * 60 * 1000;
  const cycle = input.quota.cycleHours * HOUR_MS;
  const points = new Set<number>([start, end]);

  for (let cursor = start; cursor < end; cursor += step) points.add(Math.min(cursor, end));
  const addBoundary = (value: string | null) => {
    if (value === null) return;
    const timestamp = toMs(value);
    if (timestamp >= start && timestamp <= end) points.add(timestamp);
  };
  addBoundary(input.quota.nextNaturalResetAt);
  input.cards.forEach((card) => {
    addBoundary(card.availableAt);
    addBoundary(card.expiresAt);
  });
  input.forcedResets.forEach((reset) => addBoundary(reset.at));
  input.tasks.forEach((task) => {
    addBoundary(task.availableAt);
    addBoundary(task.deadlineAt);
  });
  input.eventGroups.forEach((group) => group.outcomes.forEach((outcome) => addBoundary(outcome.at)));

  // 用卡时刻可能不是整点；它重开的自然重置也必须成为精确事件节点。
  // 反复做 +W 闭包后，任何候选用卡时刻的下一次自然重置都不会被四舍五入。
  let changed = true;
  while (changed) {
    changed = false;
    for (const point of [...points]) {
      const next = point + cycle;
      if (next > start && next < end && !points.has(next)) {
        points.add(next);
        changed = true;
      }
    }
  }
  return [...points].sort((left, right) => left - right);
}

export function durationDays(start: number, end: number): number {
  return (end - start) / DAY_MS;
}
