import { describe, expect, it } from "vitest";
import { createDefaultInput, createDemoInput } from "../src/domain/demo";
import { applyObservedForcedReset } from "../src/domain/replan";
import { hasCompleteProbabilities, scenarioCount, validatePlannerInput } from "../src/domain/validation";
import { buildTimeGrid } from "../src/solver/time-grid";
import { compilePlanningModel } from "../src/solver/planning-model";
import { estimateModel, planSolveRuns } from "../src/solver/solve";

describe("领域校验", () => {
  it("未知概率不会被擅自当成等概率", () => {
    const input = createDemoInput();
    expect(hasCompleteProbabilities(input)).toBe(false);
    input.eventGroups[0].outcomes[0].probability = 0.4;
    input.eventGroups[0].outcomes[1].probability = 0.6;
    expect(hasCompleteProbabilities(input)).toBe(true);
  });

  it("余额越界、过去自然日期和概率和错误都会定位到字段", () => {
    const input = createDemoInput();
    input.quota.initialRemainingPercent = 120;
    input.quota.nextNaturalResetAt = "2026-09-23T00:00:00+08:00";
    input.eventGroups[0].outcomes[0].probability = 0.7;
    input.eventGroups[0].outcomes[1].probability = 0.7;
    const paths = validatePlannerInput(input).map((issue) => issue.path);
    expect(paths).toContain("quota.initialRemainingPercent");
    expect(paths).toContain("quota.nextNaturalResetAt");
    expect(paths).toContain("eventGroups.0.outcomes");
  });

  it("情景数量是各互斥事件结果数的乘积", () => {
    const input = createDemoInput();
    input.eventGroups.push({
      id: "another-event",
      name: "另一个事件",
      outcomes: [
        { id: "a1", name: "A", at: null, resetsAllowance: false, resetsNaturalClock: false, probability: null },
        { id: "a2", name: "B", at: null, resetsAllowance: false, resetsNaturalClock: false, probability: null },
        { id: "a3", name: "C", at: null, resetsAllowance: false, resetsNaturalClock: false, probability: null }
      ]
    });
    expect(scenarioCount(input)).toBe(6);
  });
});

describe("时间边界与动作可行性", () => {
  it("非整点卡片失效时刻被精确插入网格", () => {
    const input = createDemoInput();
    input.cards[0].expiresAt = "2026-10-03T17:35:00+08:00";
    const grid = buildTimeGrid(input);
    expect(grid).toContain(Date.parse(input.cards[0].expiresAt));
  });

  it("卡片在严格失效时刻不可使用", () => {
    const input = createDemoInput();
    input.eventGroups = [];
    input.options.stepMinutes = 180;
    const compiled = compilePlanningModel(input, "robust", 2.5);
    const expiry = Date.parse(input.cards[0].expiresAt);
    compiled.nodes.filter((node) => node.at >= expiry).forEach((node) => {
      expect(node.cardVariables.has(0)).toBe(false);
    });
  });

  it("同刻多个刷新通过同一个 fill 变量覆盖，不会累计库存", () => {
    const input = createDemoInput();
    input.eventGroups[0].outcomes[0].at = input.quota.nextNaturalResetAt;
    input.options.stepMinutes = 180;
    const compiled = compilePlanningModel(input, "robust", 2.5);
    compiled.qAfterVariables.forEach((scenarioVariables) => {
      scenarioVariables.forEach((variable) => expect(variable).toMatch(/^qa_/));
    });
    expect(compiled.fillVariables[0]).toHaveLength(compiled.grid.length - 1);
  });
});

describe("滚动重规划与性能计划", () => {
  it("意外重置把当前状态改为 100%，只保留未来有效项目", () => {
    const input = createDemoInput();
    const at = "2026-09-29T00:00:00+08:00";
    input.cards[0].expiresAt = "2026-09-28T00:00:00+08:00";
    input.forcedResets = [{ id: "past", name: "过去", at: "2026-09-28T00:00:00+08:00", resetsNaturalClock: true }];
    const replanned = applyObservedForcedReset(input, at);
    expect(replanned.horizonStart).toBe(new Date(at).toISOString());
    expect(replanned.quota.initialRemainingPercent).toBe(100);
    expect(replanned.quota.nextNaturalResetAt).toBe(new Date(Date.parse(at) + 168 * 60 * 60 * 1000).toISOString());
    expect(replanned.cards.some((card) => card.id === "card-a")).toBe(false);
    expect(replanned.forcedResets).toHaveLength(0);
  });

  it("默认只计划一个主策略，无任务时只有使用量、时间、卡数三个目标层", () => {
    const input = createDefaultInput(new Date("2026-09-28T00:00:00Z"));
    expect(planSolveRuns(input, false)).toHaveLength(1);
    expect(planSolveRuns(input, true).map((run) => run.fullUseDays)).toEqual([2.5, 2, 3]);
    expect(estimateModel(input).objectivePasses).toBe(3);
  });
});
