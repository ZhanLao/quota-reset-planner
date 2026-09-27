import { describe, expect, it } from "vitest";
import { createDemoInput } from "../src/domain/demo";
import { hasCompleteProbabilities, scenarioCount, validatePlannerInput } from "../src/domain/validation";
import { buildTimeGrid } from "../src/solver/time-grid";
import { compilePlanningModel } from "../src/solver/planning-model";

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
    input.quota.initialBalance = 2;
    input.quota.nextNaturalResetAt = "2026-09-23T00:00:00+08:00";
    input.eventGroups[0].outcomes[0].probability = 0.7;
    input.eventGroups[0].outcomes[1].probability = 0.7;
    const paths = validatePlannerInput(input).map((issue) => issue.path);
    expect(paths).toContain("quota.initialBalance");
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
