import { describe, expect, it } from "vitest";
import { createDemoInput } from "../src/domain/demo";
import { compilePlanningModel } from "../src/solver/planning-model";
import { solveOne } from "../src/solver/solve";
import { bruteForceMaximumUsage } from "./bruteforce";

describe("复杂排程与解析上界", () => {
  it.each([2, 2.5, 3])("无额外事件时，9/24—10/5 的两卡案例最多实际使用 300%（D=%s）", async (days) => {
    const input = createDemoInput();
    input.tasks = [];
    input.eventGroups = [];
    input.options.stepMinutes = 180;
    input.options.timeLimitSeconds = 30;
    const result = await solveOne(input, "robust", days);
    expect(result.totalUsedPercent).toBeCloseTo(300, 4);
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
    input.quota.initialRemainingPercent = 0;
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
    expect(result.totalUsedPercent).toBeCloseTo(200, 5);
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
    expect(optimized.totalUsedPercent).toBeCloseTo(exhaustive, 4);
  }, 120_000);

  it("确定强制重置会取消旧自然日，并把下一自然日改为事件时刻加周期", async () => {
    const input = createDemoInput();
    input.horizonEnd = "2026-10-10T00:00:00+08:00";
    input.cards = [];
    input.tasks = [];
    input.eventGroups = [];
    input.forcedResets = [{
      id: "forced-1",
      name: "确定强制重置",
      at: "2026-09-28T00:00:00+08:00",
      resetsNaturalClock: true
    }];
    input.options.stepMinutes = 180;
    const result = await solveOne(input, "robust", 2.5);
    const timeline = result.scenarios[0].timeline;
    const oldNatural = new Date(input.quota.nextNaturalResetAt).toISOString();
    const newNatural = new Date(Date.parse(input.forcedResets[0].at) + input.quota.cycleHours * 60 * 60 * 1000).toISOString();
    expect(timeline.some((event) => event.kind === "natural-reset" && event.at === oldNatural)).toBe(false);
    expect(timeline.some((event) => event.kind === "natural-reset" && event.at === newNatural)).toBe(true);
    const forced = timeline.find((event) => event.kind === "forced-reset");
    expect(forced?.nextNaturalResetAt).toBe(newNatural);
  }, 120_000);

  it("不重开自然周期的强制重置会保留旧自然日期", async () => {
    const input = createDemoInput();
    input.horizonEnd = "2026-10-06T00:00:00+08:00";
    input.cards = [];
    input.tasks = [];
    input.eventGroups = [];
    input.forcedResets = [{ id: "forced-no-clock", name: "只刷新余额", at: "2026-09-28T00:00:00+08:00", resetsNaturalClock: false }];
    input.options.stepMinutes = 180;
    const result = await solveOne(input, "robust", 2.5);
    const oldNatural = new Date(input.quota.nextNaturalResetAt).toISOString();
    expect(result.scenarios[0].timeline.some((event) => event.kind === "natural-reset" && event.at === oldNatural)).toBe(true);
  }, 120_000);

  it("总使用量优先于高价值任务，并输出明确的用卡日期与名称", async () => {
    const input = createDemoInput();
    input.horizonStart = "2026-09-24T00:00:00+08:00";
    input.horizonEnd = "2026-09-30T00:00:00+08:00";
    input.quota.initialRemainingPercent = 0;
    input.quota.nextNaturalResetAt = "2026-09-25T00:00:00+08:00";
    input.cards = [{ id: "only-card", name: "唯一重置卡", availableAt: input.horizonStart, expiresAt: input.horizonEnd, resetsNaturalClock: true }];
    input.forcedResets = [];
    input.tasks = [{
      id: "urgent",
      name: "高价值但会牺牲总量的任务",
      availableAt: input.horizonStart,
      deadlineAt: input.quota.nextNaturalResetAt,
      quotaDemandPercent: 100,
      valuePerQuota: 100
    }];
    input.eventGroups = [];
    input.options.stepMinutes = 180;
    const result = await solveOne(input, "robust", 2);
    expect(result.totalUsedPercent).toBeCloseTo(200, 5);
    expect(result.cardUsagePlan).toHaveLength(1);
    expect(result.cardUsagePlan[0].cardName).toBe("唯一重置卡");
    expect(Date.parse(result.cardUsagePlan[0].at)).toBeGreaterThanOrEqual(Date.parse(input.quota.nextNaturalResetAt));
  }, 120_000);
});
