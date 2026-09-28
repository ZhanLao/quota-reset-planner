import { PlannerError } from "../domain/errors";
import type {
  PlannerInput,
  ResetCard,
  Scenario,
  SolveMode
} from "../domain/types";
import {
  ModelBuilder,
  addExpression,
  addTerm,
  expression,
  type Expression
} from "./model-builder";
import { enumerateScenarios, exogenousEventAt, observationKey } from "./scenarios";
import { buildTimeGrid, durationDays, HOUR_MS, toMs } from "./time-grid";

interface ActionNode {
  id: number;
  timeIndex: number;
  at: number;
  condition: string;
  scenarioIndexes: number[];
  cardVariables: Map<number, string>;
  taskVariables: Map<number, string>;
}

export interface NormalizedTask {
  id: string;
  name: string;
  availableAt: string;
  deadlineAt: string;
  quotaDemand: number;
  valuePerQuota: number;
}

export interface CompiledPlanningModel {
  builder: ModelBuilder;
  input: PlannerInput;
  mode: SolveMode;
  scenarios: Scenario[];
  grid: number[];
  tasks: NormalizedTask[];
  nodes: ActionNode[];
  nodeByScenarioAndTime: ActionNode[][];
  qInVariables: string[][];
  qAfterVariables: string[][];
  naturalVariables: Array<Array<string | null>>;
  fillVariables: string[][];
  overwriteVariables: string[][];
  clockVariables: string[][];
  utilityByScenario: Expression[];
  usageByScenario: Expression[];
  earlyByScenario: Expression[];
  cardsByScenario: Expression[];
  overwrittenByScenario: Expression[];
  taskUsageByScenario: Array<Array<Expression>>;
  objectiveTiers: Array<{ sense: "Maximize" | "Minimize"; expression: Expression; name: string }>;
  estimatedVariables: number;
  estimatedConstraints: number;
}

const GENERAL_TASK_ID = "__general__";

function cardsAvailableAt(cards: ResetCard[], at: number): number[] {
  return cards.flatMap((card, index) => (
    toMs(card.availableAt) <= at && at < toMs(card.expiresAt) ? [index] : []
  ));
}

function buildActionNodes(input: PlannerInput, scenarios: Scenario[], grid: number[]): {
  nodes: ActionNode[];
  nodeByScenarioAndTime: ActionNode[][];
} {
  const intervalCount = grid.length - 1;
  const nodes: ActionNode[] = [];
  const nodeByScenarioAndTime = scenarios.map(() => new Array<ActionNode>(intervalCount));
  for (let timeIndex = 0; timeIndex < intervalCount; timeIndex += 1) {
    const grouped = new Map<string, number[]>();
    scenarios.forEach((scenario, scenarioIndex) => {
      const key = observationKey(input, scenario, grid[timeIndex]);
      const list = grouped.get(key) ?? [];
      list.push(scenarioIndex);
      grouped.set(key, list);
    });
    grouped.forEach((scenarioIndexes, condition) => {
      const node: ActionNode = {
        id: nodes.length,
        timeIndex,
        at: grid[timeIndex],
        condition,
        scenarioIndexes,
        cardVariables: new Map(),
        taskVariables: new Map()
      };
      nodes.push(node);
      scenarioIndexes.forEach((scenarioIndex) => { nodeByScenarioAndTime[scenarioIndex][timeIndex] = node; });
    });
  }
  return { nodes, nodeByScenarioAndTime };
}

function orVariable(
  builder: ModelBuilder,
  name: string,
  inputs: string[],
  fixedTrue: boolean,
  constraintPrefix: string
): string {
  const variable = builder.addBinary(name);
  if (fixedTrue) {
    builder.addConstraint(`${constraintPrefix}_fixed`, expression([[variable, 1]]), "=", 1);
    return variable;
  }
  if (!inputs.length) {
    builder.addConstraint(`${constraintPrefix}_zero`, expression([[variable, 1]]), "=", 0);
    return variable;
  }
  inputs.forEach((input, index) => {
    builder.addConstraint(`${constraintPrefix}_lo_${index}`, expression([[variable, 1], [input, -1]]), ">=", 0);
  });
  const upper = expression([[variable, 1]]);
  inputs.forEach((input) => addTerm(upper, input, -1));
  builder.addConstraint(`${constraintPrefix}_hi`, upper, "<=", 0);
  return variable;
}

export function compilePlanningModel(input: PlannerInput, mode: SolveMode, fullUseDays: number): CompiledPlanningModel {
  const builder = new ModelBuilder();
  const scenarios = enumerateScenarios(input);
  const grid = buildTimeGrid(input);
  const intervalCount = grid.length - 1;
  const capacity = 1;
  const cycleMs = input.quota.cycleHours * HOUR_MS;
  const start = grid[0];
  const end = grid[grid.length - 1];
  const generalDemand = capacity / fullUseDays * durationDays(start, end);
  const tasks: NormalizedTask[] = [
    ...input.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      availableAt: task.availableAt,
      deadlineAt: task.deadlineAt,
      quotaDemand: task.quotaDemandPercent / 100,
      valuePerQuota: task.valuePerQuota
    })),
    {
      id: GENERAL_TASK_ID,
      name: "普通使用",
      availableAt: input.horizonStart,
      deadlineAt: input.horizonEnd,
      quotaDemand: generalDemand,
      valuePerQuota: 1
    }
  ];
  const { nodes, nodeByScenarioAndTime } = buildActionNodes(input, scenarios, grid);

  nodes.forEach((node) => {
    const availableCards = cardsAvailableAt(input.cards, node.at);
    availableCards.forEach((cardIndex) => {
      node.cardVariables.set(cardIndex, builder.addBinary(`m_n${node.id}_c${cardIndex}`));
    });
    if (availableCards.length) {
      const atMostOne = expression();
      node.cardVariables.forEach((variable) => addTerm(atMostOne, variable, 1));
      builder.addConstraint(`one_card_n${node.id}`, atMostOne, "<=", 1);
    }
    tasks.forEach((task, taskIndex) => {
      if (toMs(task.availableAt) <= node.at && node.at < toMs(task.deadlineAt)) {
        node.taskVariables.set(taskIndex, builder.addContinuous(`x_n${node.id}_t${taskIndex}`, 0, task.quotaDemand));
      }
    });
    const rate = expression();
    node.taskVariables.forEach((variable) => addTerm(rate, variable, 1));
    const intervalCapacity = capacity / fullUseDays * durationDays(grid[node.timeIndex], grid[node.timeIndex + 1]);
    builder.addConstraint(`rate_n${node.id}`, rate, "<=", intervalCapacity);
  });

  const qInVariables: string[][] = [];
  const qAfterVariables: string[][] = [];
  const naturalVariables: Array<Array<string | null>> = [];
  const fillVariables: string[][] = [];
  const overwriteVariables: string[][] = [];
  const clockVariables: string[][] = [];
  const initialClockOrigin = toMs(input.quota.nextNaturalResetAt) - cycleMs;

  scenarios.forEach((scenario, scenarioIndex) => {
    const qIn: string[] = [];
    const qAfter: string[] = [];
    const natural: Array<string | null> = [];
    const fills: string[] = [];
    const overwrites: string[] = [];
    const clocks: string[] = [];
    for (let timeIndex = 0; timeIndex <= intervalCount; timeIndex += 1) {
      const initial = timeIndex === 0 ? input.quota.initialRemainingPercent / 100 : 0;
      qIn.push(builder.addContinuous(`qi_s${scenarioIndex}_k${timeIndex}`, initial, timeIndex === 0 ? initial : capacity));
      if (timeIndex === intervalCount) break;
      qAfter.push(builder.addContinuous(`qa_s${scenarioIndex}_k${timeIndex}`, 0, capacity));
      clocks.push(builder.addBinary(`clk_s${scenarioIndex}_k${timeIndex}`));
    }
    qInVariables.push(qIn);
    qAfterVariables.push(qAfter);
    naturalVariables.push(natural);
    fillVariables.push(fills);
    overwriteVariables.push(overwrites);
    clockVariables.push(clocks);
  });

  // 自然重置由“恰好 W 之前的时钟源且中间没有新的时钟重置”直接决定。
  // 这条约束从根上替换了“用卡后仍保留旧自然日期”的错误逻辑。
  scenarios.forEach((scenario, scenarioIndex) => {
    for (let timeIndex = 0; timeIndex < intervalCount; timeIndex += 1) {
      const at = grid[timeIndex];
      const sourceTime = at - cycleMs;
      const sourceIndex = grid.findIndex((point) => point === sourceTime);
      const sourceIsInitial = sourceTime === initialClockOrigin;
      let natural: string | null = null;
      if (sourceIsInitial || (sourceIndex >= 0 && sourceIndex < timeIndex)) {
        natural = builder.addBinary(`nat_s${scenarioIndex}_k${timeIndex}`);
        const intervening = grid.flatMap((point, index) => (
          index < timeIndex && point > sourceTime ? [clockVariables[scenarioIndex][index]] : []
        ));
        if (!sourceIsInitial) {
          builder.addConstraint(
            `nat_src_s${scenarioIndex}_k${timeIndex}`,
            expression([[natural, 1], [clockVariables[scenarioIndex][sourceIndex], -1]]),
            "<=",
            0
          );
        }
        if (intervening.length) {
          const upper = expression([[natural, intervening.length]]);
          intervening.forEach((variable) => addTerm(upper, variable, 1));
          builder.addConstraint(`nat_block_s${scenarioIndex}_k${timeIndex}`, upper, "<=", intervening.length);
        }
        const lower = expression([[natural, 1]]);
        intervening.forEach((variable) => addTerm(lower, variable, 1));
        if (sourceIsInitial) {
          builder.addConstraint(`nat_fire_s${scenarioIndex}_k${timeIndex}`, lower, ">=", 1);
        } else {
          addTerm(lower, clockVariables[scenarioIndex][sourceIndex], -1);
          builder.addConstraint(`nat_fire_s${scenarioIndex}_k${timeIndex}`, lower, ">=", 0);
        }
      }
      naturalVariables[scenarioIndex].push(natural);

      const node = nodeByScenarioAndTime[scenarioIndex][timeIndex];
      const event = exogenousEventAt(input, scenario, at);
      const clockInputs: string[] = natural ? [natural] : [];
      node.cardVariables.forEach((variable, cardIndex) => {
        if (input.cards[cardIndex].resetsNaturalClock) clockInputs.push(variable);
      });
      const clock = clockVariables[scenarioIndex][timeIndex];
      if (event.resetsNaturalClock) {
        builder.addConstraint(`clk_fixed_s${scenarioIndex}_k${timeIndex}`, expression([[clock, 1]]), "=", 1);
      } else if (!clockInputs.length) {
        builder.addConstraint(`clk_zero_s${scenarioIndex}_k${timeIndex}`, expression([[clock, 1]]), "=", 0);
      } else {
        clockInputs.forEach((inputVariable, index) => {
          builder.addConstraint(
            `clk_lo_s${scenarioIndex}_k${timeIndex}_${index}`,
            expression([[clock, 1], [inputVariable, -1]]),
            ">=",
            0
          );
        });
        const clockUpper = expression([[clock, 1]]);
        clockInputs.forEach((inputVariable) => addTerm(clockUpper, inputVariable, -1));
        builder.addConstraint(`clk_hi_s${scenarioIndex}_k${timeIndex}`, clockUpper, "<=", 0);
      }

      const fillInputs: string[] = natural ? [natural] : [];
      node.cardVariables.forEach((variable) => fillInputs.push(variable));
      const fill = orVariable(
        builder,
        `fill_s${scenarioIndex}_k${timeIndex}`,
        fillInputs,
        event.resetsAllowance,
        `fill_s${scenarioIndex}_k${timeIndex}`
      );
      fillVariables[scenarioIndex].push(fill);
      const qIn = qInVariables[scenarioIndex][timeIndex];
      const qAfter = qAfterVariables[scenarioIndex][timeIndex];
      builder.addConstraint(`reset_lo_s${scenarioIndex}_k${timeIndex}`, expression([[qAfter, 1], [qIn, -1]]), ">=", 0);
      builder.addConstraint(
        `reset_hi_s${scenarioIndex}_k${timeIndex}`,
        expression([[qAfter, 1], [qIn, -1], [fill, -capacity]]),
        "<=",
        0
      );
      builder.addConstraint(`reset_full_s${scenarioIndex}_k${timeIndex}`, expression([[qAfter, 1], [fill, -capacity]]), ">=", 0);

      const overwritten = builder.addContinuous(`lost_s${scenarioIndex}_k${timeIndex}`, 0, capacity);
      overwriteVariables[scenarioIndex].push(overwritten);
      builder.addConstraint(`lost_q_s${scenarioIndex}_k${timeIndex}`, expression([[overwritten, 1], [qIn, -1]]), "<=", 0);
      builder.addConstraint(`lost_f_s${scenarioIndex}_k${timeIndex}`, expression([[overwritten, 1], [fill, -capacity]]), "<=", 0);
      builder.addConstraint(
        `lost_lo_s${scenarioIndex}_k${timeIndex}`,
        expression([[overwritten, 1], [qIn, -1], [fill, -capacity]]),
        ">=",
        -capacity
      );

      const balance = expression([
        [qInVariables[scenarioIndex][timeIndex + 1], 1],
        [qAfter, -1]
      ]);
      node.taskVariables.forEach((variable) => addTerm(balance, variable, 1));
      builder.addConstraint(`balance_s${scenarioIndex}_k${timeIndex}`, balance, "=", 0);
    }
  });

  const utilityByScenario: Expression[] = [];
  const usageByScenario: Expression[] = [];
  const earlyByScenario: Expression[] = [];
  const cardsByScenario: Expression[] = [];
  const overwrittenByScenario: Expression[] = [];
  const taskUsageByScenario: Array<Array<Expression>> = [];

  scenarios.forEach((_scenario, scenarioIndex) => {
    const utility = expression();
    const usage = expression();
    const early = expression();
    const cards = expression();
    const overwritten = expression();
    const taskUsage = tasks.map(() => expression());
    for (let timeIndex = 0; timeIndex < intervalCount; timeIndex += 1) {
      const node = nodeByScenarioAndTime[scenarioIndex][timeIndex];
      node.taskVariables.forEach((variable, taskIndex) => {
        addTerm(taskUsage[taskIndex], variable, 1);
        addTerm(utility, variable, tasks[taskIndex].valuePerQuota);
        addTerm(usage, variable, 1);
        addTerm(early, variable, durationDays(start, grid[timeIndex]));
      });
      node.cardVariables.forEach((variable) => addTerm(cards, variable, 1));
      addTerm(overwritten, overwriteVariables[scenarioIndex][timeIndex], 1);
    }
    taskUsage.forEach((taskExpression, taskIndex) => {
      builder.addConstraint(`demand_s${scenarioIndex}_t${taskIndex}`, taskExpression, "<=", tasks[taskIndex].quotaDemand);
    });
    input.cards.forEach((_card, cardIndex) => {
      const once = expression();
      for (let timeIndex = 0; timeIndex < intervalCount; timeIndex += 1) {
        const variable = nodeByScenarioAndTime[scenarioIndex][timeIndex].cardVariables.get(cardIndex);
        if (variable) addTerm(once, variable, 1);
      }
      builder.addConstraint(`card_once_s${scenarioIndex}_c${cardIndex}`, once, "<=", 1);
    });
    utilityByScenario.push(utility);
    usageByScenario.push(usage);
    earlyByScenario.push(early);
    cardsByScenario.push(cards);
    overwrittenByScenario.push(overwritten);
    taskUsageByScenario.push(taskUsage);
  });

  const objectiveTiers: CompiledPlanningModel["objectiveTiers"] = [];
  if (mode === "expected") {
    const expectedUtility = expression();
    const expectedUsage = expression();
    const expectedEarly = expression();
    const expectedCards = expression();
    scenarios.forEach((scenario, scenarioIndex) => {
      if (scenario.probability === null) throw new PlannerError("INPUT_INVALID", "概率不完整时不能计算期望策略。");
      addExpression(expectedUtility, utilityByScenario[scenarioIndex], scenario.probability);
      addExpression(expectedUsage, usageByScenario[scenarioIndex], scenario.probability);
      addExpression(expectedEarly, earlyByScenario[scenarioIndex], scenario.probability);
      addExpression(expectedCards, cardsByScenario[scenarioIndex], scenario.probability);
    });
    // 总使用量是主目标；任务价值只能在总量已固定后改变额度分配，不能牺牲总使用量。
    objectiveTiers.push(
      { sense: "Maximize", expression: expectedUsage, name: "expected_usage" },
      ...(input.tasks.length ? [{ sense: "Maximize" as const, expression: expectedUtility, name: "expected_utility" }] : []),
      { sense: "Minimize", expression: expectedEarly, name: "expected_early" },
      { sense: "Minimize", expression: expectedCards, name: "expected_cards" }
    );
  } else {
    if (scenarios.length === 1) {
      // 单情景直接使用原表达式，省去没有意义的 worst_* 辅助变量和重复期望策略。
      objectiveTiers.push(
        { sense: "Maximize", expression: usageByScenario[0], name: "deterministic_usage" },
        ...(input.tasks.length ? [{ sense: "Maximize" as const, expression: utilityByScenario[0], name: "deterministic_utility" }] : []),
        { sense: "Minimize", expression: earlyByScenario[0], name: "deterministic_early" },
        { sense: "Minimize", expression: cardsByScenario[0], name: "deterministic_cards" }
      );
    } else {
    const worstUtility = input.tasks.length ? builder.addContinuous("worst_utility", 0) : null;
    const worstUsage = builder.addContinuous("worst_usage", 0);
    const worstEarly = builder.addContinuous("worst_early", 0);
    const worstCards = builder.addContinuous("worst_cards", 0);
    const allScenarioUsage = expression();
    scenarios.forEach((_scenario, scenarioIndex) => {
      if (worstUtility) {
        const utilityBound = expression([[worstUtility, 1]]);
        addExpression(utilityBound, utilityByScenario[scenarioIndex], -1);
        builder.addConstraint(`worst_u_s${scenarioIndex}`, utilityBound, "<=", 0);
      }
      const usageBound = expression([[worstUsage, 1]]);
      addExpression(usageBound, usageByScenario[scenarioIndex], -1);
      builder.addConstraint(`worst_y_s${scenarioIndex}`, usageBound, "<=", 0);
      addExpression(allScenarioUsage, usageByScenario[scenarioIndex]);
      const earlyBound = expression([[worstEarly, 1]]);
      addExpression(earlyBound, earlyByScenario[scenarioIndex], -1);
      builder.addConstraint(`worst_e_s${scenarioIndex}`, earlyBound, ">=", 0);
      const cardBound = expression([[worstCards, 1]]);
      addExpression(cardBound, cardsByScenario[scenarioIndex], -1);
      builder.addConstraint(`worst_c_s${scenarioIndex}`, cardBound, ">=", 0);
    });
    // 保底值相同时再最大化所有分支总用量，防止有利分支无谓闲置；这不是概率预测。
    objectiveTiers.push(
      { sense: "Maximize", expression: expression([[worstUsage, 1]]), name: "worst_usage" },
      { sense: "Maximize", expression: allScenarioUsage, name: "all_scenario_usage" },
      ...(worstUtility ? [{ sense: "Maximize" as const, expression: expression([[worstUtility, 1]]), name: "worst_utility" }] : []),
      { sense: "Minimize", expression: expression([[worstEarly, 1]]), name: "worst_early" },
      { sense: "Minimize", expression: expression([[worstCards, 1]]), name: "worst_cards" }
    );
    }
  }

  const estimatedVariables = builder.variableCount();
  const estimatedConstraints = builder.constraintCount();
  if (estimatedVariables > 250_000 || estimatedConstraints > 1_000_000) {
    throw new PlannerError(
      "MODEL_TOO_LARGE",
      `模型预计包含 ${estimatedVariables} 个变量和 ${estimatedConstraints} 条约束。`,
      ["请调粗时间步长、缩短时域或减少不确定情景。"]
    );
  }

  return {
    builder,
    input,
    mode,
    scenarios,
    grid,
    tasks,
    nodes,
    nodeByScenarioAndTime,
    qInVariables,
    qAfterVariables,
    naturalVariables,
    fillVariables,
    overwriteVariables,
    clockVariables,
    utilityByScenario,
    usageByScenario,
    earlyByScenario,
    cardsByScenario,
    overwrittenByScenario,
    taskUsageByScenario,
    objectiveTiers,
    estimatedVariables,
    estimatedConstraints
  };
}
