import { describe, expect, it } from "vitest";
import { createDemoInput } from "../src/domain/demo";
import { compilePlanningModel } from "../src/solver/planning-model";
import { solveOne } from "../src/solver/solve";
import { bruteForceMaximumUsage } from "./bruteforce";

describe("复杂排程与解析上界", () => {
  it.each([2, 2.5, 3])("无额外事件时，9/24—10/5 的两卡案例最多实际使用 3 份（D=%s）", async (days) => {
    const input = createDemoInput();
    input.tasks = [];
    input.eventGroups = [];
    input.options.stepMinutes = 180;
    input.options.timeLimitSeconds = 30;
    const result = await solveOne(input, "robust", days);
    expect(result.totalUsed).toBeCloseTo(3, 5);
  }, 120_000);

  it("未来事件被观察前共享动作，观察后才允许策略分叉", () => {
    const input = createDemoInput();
    input.options.stepMinutes = 180;
    const compiled = compilePlanningModel(input, "robust", 2.5);
    const eventTime = Date.parse("2026-09-29T00:00:00+08:00");
    compiled.grid.forEach((at, timeIndex) => {
      if (timeIndex >= compiled.grid.length - 1 || at >= eventTime) return;
      expect(compiled.nodeByScenarioAndTime[0][timeIndex]).toBe(compiled.nodeByScenarioAndTime[1][timeIndex]);
    });
    const eventIndex = compiled.grid.indexOf(eventTime);
    expect(compiled.nodeByScenarioAndTime[0][eventIndex]).not.toBe(compiled.nodeByScenarioAndTime[1][eventIndex]);
  });

  it("贪心反例会等待次日自然重置，再使用唯一卡片", async () => {
    const input = createDemoInput();
    input.horizonStart = "2026-09-24T00:00:00+08:00";
    input.horizonEnd = "2026-09-30T00:00:00+08:00";
    input.quota.initialBalance = 0;
    input.quota.nextNaturalResetAt = "2026-09-25T00:00:00+08:00";
    input.quota.fullUseDays = 2;
    input.cards = [{
      id: "only-card",
      name: "唯一卡片",
      availableAt: input.horizonStart,
      expiresAt: input.horizonEnd,
      resetsNaturalClock: true
    }];
    input.tasks = [];
    input.eventGroups = [];
    input.options.stepMinutes = 180;
    input.options.timeLimitSeconds = 30;
    const result = await solveOne(input, "robust", 2);
    expect(result.totalUsed).toBeCloseTo(2, 5);
    const cardAction = result.policy.find((action) => action.cardId === "only-card");
    expect(cardAction).toBeDefined();
    expect(Date.parse(cardAction!.at)).toBeGreaterThanOrEqual(Date.parse(input.quota.nextNaturalResetAt));
  }, 120_000);

  it("小规模确定实例与独立穷举器一致", async () => {
    const input = createDemoInput();
    input.horizonEnd = "2026-09-30T00:00:00+08:00";
    input.quota.nextNaturalResetAt = "2026-09-27T00:00:00+08:00";
    input.cards = input.cards.slice(0, 1);
    input.cards[0].expiresAt = "2026-09-29T00:00:00+08:00";
    input.tasks = [];
    input.eventGroups = [];
    input.options.stepMinutes = 180;
    input.options.timeLimitSeconds = 30;
    const exhaustive = bruteForceMaximumUsage(input, 2);
    const optimized = await solveOne(input, "robust", 2);
    expect(optimized.totalUsed).toBeCloseTo(exhaustive, 5);
  }, 120_000);
});
