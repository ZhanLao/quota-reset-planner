import loadHighs from "highs";
import highsWasmUrl from "highs/runtime?url";
import { PlannerError } from "../domain/errors";
import type {
  CardUsagePlanItem,
  PlannerInput,
  PolicyAction,
  ScenarioMetrics,
  SolveBundle,
  SolveMode,
  SolveResult,
  SolverProgress,
  TimelineEvent
} from "../domain/types";
import { hasCompleteProbabilities, validatePlannerInput } from "../domain/validation";
import {
  ModelBuilder,
  addExpression,
  cloneExpression,
  type Expression
} from "./model-builder";
import { compilePlanningModel, type CompiledPlanningModel } from "./planning-model";
import { conditionLabel, exogenousEventAt } from "./scenarios";
import { HOUR_MS, toIso } from "./time-grid";

interface RawColumn {
  Primal: number;
}

interface RawSolveResult {
  Status: string;
  ObjectiveValue: number;
  Columns?: Record<string, RawColumn>;
  Info?: Record<string, number>;
  MipGap?: number;
}

interface HighsRuntime {
  solve(model: string, options?: Record<string, string | number | boolean>): RawSolveResult;
}

let runtimePromise: Promise<HighsRuntime> | null = null;

async function runtime(): Promise<HighsRuntime> {
  try {
    // Node 测试让 highs 使用包内默认路径；浏览器 Worker 使用 Vite 打包后的同源 WASM URL。
    // 这样离线 PWA 不会运行时访问 CDN，也避免 GitHub Pages 子路径导致定位失败。
    const inBrowserWorker = typeof self !== "undefined" && "location" in self;
    runtimePromise ??= loadHighs(inBrowserWorker ? {
      locateFile: (file) => file.endsWith(".wasm") ? highsWasmUrl : file
    } : undefined) as Promise<HighsRuntime>;
    return await runtimePromise;
  } catch (error) {
    throw new PlannerError(
      "WASM_LOAD_FAILED",
      "HiGHS WebAssembly 求解器加载失败。",
      [error instanceof Error ? error.message : String(error)]
    );
  }
}

function valueOf(value: Expression, columns: Record<string, RawColumn>): number {
  let total = 0;
  value.forEach((coefficient, variable) => { total += coefficient * (columns[variable]?.Primal ?? 0); });
  return total;
}

function primal(columns: Record<string, RawColumn>, variable: string | null | undefined): number {
  return variable ? columns[variable]?.Primal ?? 0 : 0;
}

function isOptimal(status: string): boolean {
  return status.toLowerCase().includes("optimal");
}

function hasFeasibleColumns(result: RawSolveResult): result is RawSolveResult & { Columns: Record<string, RawColumn> } {
  return Boolean(result.Columns && Object.keys(result.Columns).length);
}

async function solveLexicographic(
  compiled: CompiledPlanningModel
): Promise<{ raw: RawSolveResult & { Columns: Record<string, RawColumn> }; allOptimal: boolean }> {
  const highs = await runtime();
  const extra: ReturnType<typeof ModelBuilder.extraConstraint>[] = [];
  let final: RawSolveResult | null = null;
  let allOptimal = true;
  const tolerance = 1e-7;
  for (let tierIndex = 0; tierIndex < compiled.objectiveTiers.length; tierIndex += 1) {
    const tier = compiled.objectiveTiers[tierIndex];
    const model = compiled.builder.render(tier.sense, tier.expression, extra);
    final = highs.solve(model, {
      output_flag: false,
      time_limit: compiled.input.options.timeLimitSeconds,
      mip_rel_gap: 1e-7,
      presolve: "on"
    });
    if (!hasFeasibleColumns(final)) {
      throw new PlannerError(
        final.Status.toLowerCase().includes("time") ? "SOLVER_TIMEOUT" : "INPUT_INVALID",
        `求解器未返回可行策略：${final.Status}`
      );
    }
    allOptimal &&= isOptimal(final.Status);
    const achieved = valueOf(tier.expression, final.Columns);
    extra.push(ModelBuilder.extraConstraint(
      `fix_tier_${tierIndex}`,
      cloneExpression(tier.expression),
      tier.sense === "Maximize" ? ">=" : "<=",
      tier.sense === "Maximize" ? achieved - tolerance : achieved + tolerance
    ));
  }
  if (!final || !hasFeasibleColumns(final)) throw new PlannerError("INPUT_INVALID", "求解器没有生成最终策略。");
  return { raw: final, allOptimal };
}

function buildScenarioMetrics(
  compiled: CompiledPlanningModel,
  columns: Record<string, RawColumn>
): ScenarioMetrics[] {
  const intervalCount = compiled.grid.length - 1;
  return compiled.scenarios.map((scenario, scenarioIndex) => {
    const timeline: TimelineEvent[] = [];
    const cardsUsed = new Set<string>();
    const taskUsage: Record<string, number> = {};
    let nextNatural = Date.parse(compiled.input.quota.nextNaturalResetAt);
    for (let timeIndex = 0; timeIndex < intervalCount; timeIndex += 1) {
      const at = compiled.grid[timeIndex];
      const qInPercent = primal(columns, compiled.qInVariables[scenarioIndex][timeIndex]) * 100;
      let balanceBeforeManualPercent = qInPercent;
      if (primal(columns, compiled.naturalVariables[scenarioIndex][timeIndex]) > 0.5) {
        nextNatural = at + compiled.input.quota.cycleHours * HOUR_MS;
        timeline.push({
          at: toIso(at),
          kind: "natural-reset",
          title: "自然重置",
          detail: `余额覆盖为 100%，下一自然重置改为 ${toIso(nextNatural)}。`,
          balanceBeforePercent: qInPercent,
          overwrittenPercent: qInPercent,
          nextNaturalResetAt: toIso(nextNatural)
        });
        balanceBeforeManualPercent = 100;
      }
      const event = exogenousEventAt(compiled.input, scenario, at);
      if (event.forcedNames.length) {
        if (event.forcedResetsNaturalClock) nextNatural = at + compiled.input.quota.cycleHours * HOUR_MS;
        timeline.push({
          at: toIso(at),
          kind: "forced-reset",
          title: event.forcedNames.join("；"),
          detail: event.forcedResetsNaturalClock
            ? `强制覆盖为 100%，下一自然重置改为 ${toIso(nextNatural)}。`
            : `强制覆盖为 100%，下一自然重置仍为 ${toIso(nextNatural)}。`,
          balanceBeforePercent: balanceBeforeManualPercent,
          overwrittenPercent: balanceBeforeManualPercent,
          nextNaturalResetAt: toIso(nextNatural)
        });
        balanceBeforeManualPercent = 100;
      }
      if (event.names.length) {
        if (event.uncertainResetsNaturalClock) nextNatural = at + compiled.input.quota.cycleHours * HOUR_MS;
        timeline.push({
          at: toIso(at),
          kind: "extra-reset",
          title: event.names.join("；"),
          detail: event.uncertainResetsAllowance
            ? `额外事件覆盖为 100%，下一自然重置${event.uncertainResetsNaturalClock ? `改为 ${toIso(nextNatural)}` : `仍为 ${toIso(nextNatural)}`}。`
            : "本情景在此时刻观察到事件结果，但没有刷新额度。"
        });
        if (event.uncertainResetsAllowance) balanceBeforeManualPercent = 100;
      }
      const node = compiled.nodeByScenarioAndTime[scenarioIndex][timeIndex];
      node.cardVariables.forEach((variable, cardIndex) => {
        if (primal(columns, variable) > 0.5) {
          const card = compiled.input.cards[cardIndex];
          cardsUsed.add(card.id);
          if (card.resetsNaturalClock) nextNatural = at + compiled.input.quota.cycleHours * HOUR_MS;
          timeline.push({
            at: toIso(at),
            kind: "use-card",
            title: `使用：${card.name}`,
            detail: card.resetsNaturalClock
              ? `覆盖为 100%，下一自然重置改为 ${toIso(nextNatural)}。`
              : `覆盖为 100%，下一自然重置仍为 ${toIso(nextNatural)}。`,
            balanceBeforePercent: balanceBeforeManualPercent,
            overwrittenPercent: balanceBeforeManualPercent,
            nextNaturalResetAt: toIso(nextNatural),
            cardId: card.id
          });
          balanceBeforeManualPercent = 100;
        }
      });
      node.taskVariables.forEach((variable, taskIndex) => {
        const amount = primal(columns, variable);
        if (amount <= 1e-8) return;
        const task = compiled.tasks[taskIndex];
        const percent = amount * 100;
        taskUsage[task.id] = (taskUsage[task.id] ?? 0) + percent;
        timeline.push({
          at: toIso(at),
          kind: "work",
          title: task.name,
          detail: `本时段使用 ${percent.toFixed(2)}%。`,
          quotaAmountPercent: percent
        });
      });
    }
    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      probability: scenario.probability,
      weightedTaskValue: compiled.input.tasks.reduce((sum, task, taskIndex) => (
        sum + valueOf(compiled.taskUsageByScenario[scenarioIndex][taskIndex], columns) * 100 * task.valuePerQuota
      ), 0),
      totalUsedPercent: valueOf(compiled.usageByScenario[scenarioIndex], columns) * 100,
      overwrittenPercent: valueOf(compiled.overwrittenByScenario[scenarioIndex], columns) * 100,
      cardsUsed: [...cardsUsed],
      unusedCards: compiled.input.cards.filter((card) => !cardsUsed.has(card.id)).map((card) => card.id),
      taskUsagePercent: taskUsage,
      timeline
    };
  });
}

function buildPolicy(compiled: CompiledPlanningModel, columns: Record<string, RawColumn>): PolicyAction[] {
  return compiled.nodes.flatMap((node) => {
    let cardId: string | undefined;
    node.cardVariables.forEach((variable, cardIndex) => {
      if (primal(columns, variable) > 0.5) cardId = compiled.input.cards[cardIndex].id;
    });
    const allocations = [...node.taskVariables.entries()].flatMap(([taskIndex, variable]) => {
      const quota = primal(columns, variable);
      return quota > 1e-8 ? [{ taskId: compiled.tasks[taskIndex].id, quota }] : [];
    });
    if (!cardId && !allocations.length) return [];
    const card = cardId ? compiled.input.cards.find((candidate) => candidate.id === cardId) : undefined;
    return [{
      at: toIso(node.at),
      condition: node.condition,
      conditionLabel: conditionLabel(compiled.input, node.condition),
      cardId,
      cardName: card?.name,
      allocations: allocations.map((allocation) => ({ taskId: allocation.taskId, quotaPercent: allocation.quota * 100 }))
    }];
  });
}

function buildCardUsagePlan(policy: PolicyAction[], scenarios: ScenarioMetrics[]): CardUsagePlanItem[] {
  return policy.flatMap((action) => {
    if (!action.cardId || !action.cardName) return [];
    const event = scenarios
      .flatMap((scenario) => scenario.timeline)
      .find((candidate) => candidate.kind === "use-card" && candidate.at === action.at && candidate.cardId === action.cardId);
    return [{
      at: action.at,
      cardId: action.cardId,
      cardName: action.cardName,
      conditionLabel: action.conditionLabel,
      balanceBeforePercent: event?.balanceBeforePercent ?? 0,
      overwrittenPercent: event?.overwrittenPercent ?? 0,
      nextNaturalResetAt: event?.nextNaturalResetAt ?? null
    }];
  }).sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

function safeMipGap(raw: RawSolveResult): number | null {
  const candidates = [raw.MipGap, raw.Info?.mip_gap, raw.Info?.mip_gap_value];
  const value = candidates.find((candidate) => typeof candidate === "number" && Number.isFinite(candidate));
  return value ?? null;
}

export async function solveOne(input: PlannerInput, mode: SolveMode, fullUseDays: number): Promise<SolveResult> {
  const started = performance.now();
  const compiled = compilePlanningModel(input, mode, fullUseDays);
  const { raw, allOptimal } = await solveLexicographic(compiled);
  const scenarios = buildScenarioMetrics(compiled, raw.Columns);
  const expectedUsedPercent = scenarios.every((scenario) => scenario.probability !== null)
    ? scenarios.reduce((sum, scenario) => sum + scenario.totalUsedPercent * (scenario.probability ?? 0), 0)
    : null;
  const worstCaseUsedPercent = Math.min(...scenarios.map((scenario) => scenario.totalUsedPercent));
  const totalUsedPercent = mode === "expected" && expectedUsedPercent !== null
    ? expectedUsedPercent
    : worstCaseUsedPercent;
  const policy = buildPolicy(compiled, raw.Columns);
  const warnings = [
    `手动用卡时刻按 ${input.options.stepMinutes} 分钟网格枚举；输入事件边界保持精确。`
  ];
  if (!allOptimal) warnings.push("求解器返回了可行方案，但没有在限时内证明全局最优；请查看最优间隙。");
  return {
    mode,
    status: allOptimal ? "optimal" : "feasible",
    optimal: allOptimal,
    solverStatus: raw.Status,
    mipGap: safeMipGap(raw),
    durationMs: performance.now() - started,
    gridPoints: compiled.grid.length,
    scenarioCount: compiled.scenarios.length,
    solvePasses: compiled.objectiveTiers.length,
    stepMinutes: input.options.stepMinutes,
    fullUseDays,
    objectiveValue: totalUsedPercent,
    totalUsedPercent,
    equivalentFullQuotas: totalUsedPercent / 100,
    worstCaseUsedPercent,
    expectedUsedPercent,
    scenarios,
    policy,
    cardUsagePlan: buildCardUsagePlan(policy, scenarios),
    warnings
  };
}

export async function solvePlanner(
  input: PlannerInput,
  inputRevision: number,
  includeSensitivity = false,
  onProgress?: (progress: SolverProgress) => void
): Promise<SolveBundle> {
  const issues = validatePlannerInput(input);
  if (issues.length) {
    throw new PlannerError("INPUT_INVALID", "输入参数未通过校验。", issues.map((issue) => `${issue.path}: ${issue.message}`));
  }
  const plan = planSolveRuns(input, includeSensitivity);
  let robustPrimary: SolveResult | null = null;
  let expected: SolveResult | null = null;
  const sensitivity: SolveResult[] = [];
  for (let index = 0; index < plan.length; index += 1) {
    const item = plan[index];
    onProgress?.({ phase: item.label, completed: index, total: plan.length });
    const result = await solveOne(input, item.mode, item.fullUseDays);
    if (item.purpose === "primary") robustPrimary = result;
    else if (item.purpose === "expected") expected = result;
    else sensitivity.push(result);
  }
  if (!robustPrimary) throw new PlannerError("INPUT_INVALID", "求解计划缺少主策略。");
  if (includeSensitivity) sensitivity.unshift(robustPrimary);
  sensitivity.sort((left, right) => left.fullUseDays - right.fullUseDays);
  onProgress?.({ phase: "完成", completed: plan.length, total: plan.length });
  return {
    inputRevision,
    generatedAt: new Date().toISOString(),
    primaryDays: input.quota.fullUseDays,
    expected,
    robust: robustPrimary,
    sensitivity
  };
}

export interface PlannedSolveRun {
  mode: SolveMode;
  fullUseDays: number;
  purpose: "primary" | "expected" | "sensitivity";
  label: string;
}

export function planSolveRuns(input: PlannerInput, includeSensitivity: boolean): PlannedSolveRun[] {
  const plan: PlannedSolveRun[] = [{
    mode: "robust",
    fullUseDays: input.quota.fullUseDays,
    purpose: "primary",
    label: input.eventGroups.length ? "计算主保底策略" : "计算确定性主策略"
  }];
  if (input.eventGroups.length > 0 && hasCompleteProbabilities(input)) {
    plan.push({ mode: "expected", fullUseDays: input.quota.fullUseDays, purpose: "expected", label: "计算主期望策略" });
  }
  if (includeSensitivity) {
    [...new Set(input.quota.sensitivityDays)]
      .filter((days) => days !== input.quota.fullUseDays)
      .sort((left, right) => left - right)
      .forEach((days) => plan.push({ mode: "robust", fullUseDays: days, purpose: "sensitivity", label: `速度对比：${days} 天用完 100%` }));
  }
  return plan;
}

export function estimateModel(input: PlannerInput): {
  gridPoints: number;
  scenarios: number;
  variables: number;
  constraints: number;
  objectivePasses: number;
  strategyRuns: number;
} {
  const compiled = compilePlanningModel(input, "robust", input.quota.fullUseDays);
  return {
    gridPoints: compiled.grid.length,
    scenarios: compiled.scenarios.length,
    variables: compiled.estimatedVariables,
    constraints: compiled.estimatedConstraints,
    objectivePasses: compiled.objectiveTiers.length,
    strategyRuns: planSolveRuns(input, false).length
  };
}

export function scenarioUsageExpression(compiled: CompiledPlanningModel, scenarioIndex: number): Expression {
  const result = cloneExpression(compiled.usageByScenario[scenarioIndex]);
  addExpression(result, compiled.overwrittenByScenario[scenarioIndex], 0);
  return result;
}
