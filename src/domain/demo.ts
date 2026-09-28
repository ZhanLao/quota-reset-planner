import type { PlannerInput } from "./types";

export function createDefaultInput(now = new Date()): PlannerInput {
  const start = new Date(now);
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
  const nextReset = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return {
    schemaVersion: 2,
    timezone: "Asia/Shanghai",
    horizonStart: start.toISOString(),
    horizonEnd: end.toISOString(),
    quota: {
      initialRemainingPercent: 100,
      nextNaturalResetAt: nextReset.toISOString(),
      cycleHours: 168,
      fullUseDays: 2.5,
      sensitivityDays: [2, 2.5, 3]
    },
    cards: [],
    forcedResets: [],
    tasks: [],
    eventGroups: [],
    options: { stepMinutes: 60, timeLimitSeconds: 15, scenarioLimit: 16 }
  };
}

export function createDemoInput(): PlannerInput {
  return {
    schemaVersion: 2,
    timezone: "Asia/Shanghai",
    horizonStart: "2026-09-24T00:00:00+08:00",
    horizonEnd: "2026-10-05T00:00:00+08:00",
    quota: {
      initialRemainingPercent: 100,
      nextNaturalResetAt: "2026-10-01T00:00:00+08:00",
      cycleHours: 168,
      fullUseDays: 2.5,
      sensitivityDays: [2, 2.5, 3]
    },
    cards: [
      {
        id: "card-a",
        name: "10 月 4 日到期卡",
        availableAt: "2026-09-24T00:00:00+08:00",
        expiresAt: "2026-10-04T00:00:00+08:00",
        resetsNaturalClock: true
      },
      {
        id: "card-b",
        name: "10 月 10 日到期卡",
        availableAt: "2026-09-24T00:00:00+08:00",
        expiresAt: "2026-10-10T00:00:00+08:00",
        resetsNaturalClock: true
      }
    ],
    forcedResets: [],
    tasks: [
      {
        id: "important-project",
        name: "高价值项目冲刺",
        availableAt: "2026-09-29T00:00:00+08:00",
        deadlineAt: "2026-10-04T00:00:00+08:00",
        quotaDemandPercent: 120,
        valuePerQuota: 5,
        note: "示例任务，请替换为自己的任务。"
      }
    ],
    eventGroups: [
      {
        id: "devday-reset",
        name: "9 月 29 日可能额外重置",
        outcomes: [
          {
            id: "devday-happens",
            name: "发生额外重置",
            at: "2026-09-29T00:00:00+08:00",
            resetsAllowance: true,
            resetsNaturalClock: true,
            probability: null
          },
          {
            id: "devday-none",
            name: "未发生",
            at: null,
            resetsAllowance: false,
            resetsNaturalClock: false,
            probability: null
          }
        ]
      }
    ],
    options: { stepMinutes: 60, timeLimitSeconds: 15, scenarioLimit: 16 }
  };
}
