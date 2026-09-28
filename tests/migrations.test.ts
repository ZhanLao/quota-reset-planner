import { describe, expect, it } from "vitest";
import { createDefaultInput } from "../src/domain/demo";
import { createEnvelope } from "../src/storage/project-store";
import { decodeAndMigrateEnvelope } from "../src/storage/migrations";

function legacy(capacity: number, balance: number, demand: number) {
  return {
    schemaVersion: 1,
    inputRevision: 4,
    lastResult: { stale: true },
    input: {
      schemaVersion: 1,
      timezone: "Asia/Shanghai",
      horizonStart: "2026-09-24T00:00:00+08:00",
      horizonEnd: "2026-10-05T00:00:00+08:00",
      quota: { capacity, initialBalance: balance, nextNaturalResetAt: "2026-10-01T00:00:00+08:00", cycleHours: 168, fullUseDays: 2.5, sensitivityDays: [2, 2.5, 3] },
      cards: [],
      tasks: [{ id: "t", name: "任务", availableAt: "2026-09-24T00:00:00+08:00", deadlineAt: "2026-10-04T00:00:00+08:00", quotaDemand: demand, valuePerQuota: 2 }],
      eventGroups: [],
      options: { stepMinutes: 60, timeLimitSeconds: 15, scenarioLimit: 16 }
    }
  };
}

describe("schema v1 到百分比 v2 迁移", () => {
  it("按旧容量换算余额与任务，并清除旧结果", () => {
    const first = decodeAndMigrateEnvelope(legacy(1, 0.35, 0.5), "2026-09-28T00:00:00Z");
    expect(first.project.input.quota.initialRemainingPercent).toBeCloseTo(35);
    expect(first.project.input.tasks[0].quotaDemandPercent).toBeCloseTo(50);
    expect(first.project.inputRevision).toBe(5);
    expect(first.project.lastResult).toBeUndefined();
    expect(first.migrationNotice).toBeTruthy();

    const second = decodeAndMigrateEnvelope(legacy(2, 1, 0.5));
    expect(second.project.input.quota.initialRemainingPercent).toBeCloseTo(50);
    expect(second.project.input.tasks[0].quotaDemandPercent).toBeCloseTo(25);
  });

  it("v2 重复读取不再次换算，未来版本明确拒绝", () => {
    const current = createEnvelope(createDefaultInput(new Date("2026-09-28T00:00:00Z")));
    expect(decodeAndMigrateEnvelope(current).project).toEqual(current);
    expect(() => decodeAndMigrateEnvelope({ schemaVersion: 3 })).toThrow(/不支持/);
  });
});
