import loadHighs from "highs";
import highsWasmUrl from "highs/runtime?url";
import { PlannerError } from "../domain/errors";
import type {
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
import { exogenousEventAt } from "./scenarios";
import { durationDays, toIso } from "./time-grid";

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
    for (let timeIndex = 0; timeIndex < intervalCount; timeIndex += 1) {
      const at = compiled.grid[timeIndex];
      if (primal(columns, compiled.naturalVariables[scenarioIndex][timeIndex]) > 0.5) {
        timeline.push({
          at: toIso(at),
          kind: "natural-reset",
          title: "自然重置",
          detail: "余额被覆盖为满额，并从本时刻重新计算自然周期。"
        });
      }
      const event = exogenousEventAt(compiled.input, scenario, at);
      if (event.names.length) {
        timeline.push({
          at: toIso(at),
          kind: "extra-reset",
          title: event.names.join("；"),
          detail: event.resetsAllowance
            ? `额外事件刷新额度${event.resetsNaturalClock ? "并重开自然时钟" : "，但不改变自然时钟"}。`
            : "本情景在此时刻观察到事件结果，但没有刷新额度。"
        });
      }
      const node = compiled.nodeByScenarioAndTime[scenarioIndex][timeIndex];
      node.cardVariables.forEach((variable, cardIndex) => {
        if (primal(columns, variable) > 0.5) {
          const card = compiled.input.cards[cardIndex];
          cardsUsed.add(card.id);
          timeline.push({
            at: toIso(at),
            kind: "use-card",
            title: `使用：${card.name}`,
            detail: card.resetsNaturalClock ? "覆盖当前余额，并把下一自然重置改为本时刻加一个周期。" : "覆盖当前余额，不改变自然时钟。"
          });
        }
      });
      node.taskVariables.forEach((variable, taskIndex) => {
        const amount = primal(columns, variable);
        if (amount <= 1e-8) return;
        const task = compiled.tasks[taskIndex];
        taskUsage[task.id] = (taskUsage[task.id] ?? 0) + amount;
        timeline.push({
          at: toIso(at),
          kind: "work",
          title: task.name,
          detail: `本时段使用 ${amount.toFixed(4)} 份额度。`,
          quotaAmount: amount
        });
      });
    }
    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      probability: scenario.probability,
      weightedValue: valueOf(compiled.utilityByScenario[scenarioIndex], columns),
      totalUsed: valueOf(compiled.usageByScenario[scenarioIndex], columns),
      overwrittenBalance: valueOf(compiled.overwrittenByScenario[scenarioIndex], columns),
      cardsUsed: [...cardsUsed],
      unusedCards: compiled.input.cards.filter((card) => !cardsUsed.has(card.id)).map((card) => card.id),
      taskUsage,
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
    return [{ at: toIso(node.at), condition: node.condition, cardId, allocations }];
  });
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
  const expectedValue = scenarios.every((scenario) => scenario.probability !== null)
    ? scenarios.reduce((sum, scenario) => sum + scenario.weightedValue * (scenario.probability ?? 0), 0)
    : null;
  const worstCaseValue = Math.min(...scenarios.map((scenario) => scenario.weightedValue));
  const totalUsed = mode === "expected" && scenarios.every((scenario) => scenario.probability !== null)
    ? scenarios.reduce((sum, scenario) => sum + scenario.totalUsed * (scenario.probability ?? 0), 0)
    : Math.min(...scenarios.map((scenario) => scenario.totalUsed));
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
    stepMinutes: input.options.stepMinutes,
    fullUseDays,
    objectiveValue: mode === "expected" ? expectedValue ?? worstCaseValue : worstCaseValue,
    totalUsed,
    worstCaseValue,
    expectedValue,
    scenarios,
    policy: buildPolicy(compiled, raw.Columns),
    warnings
  };
}

export async function solvePlanner(
  input: PlannerInput,
  inputRevision: number,
  onProgress?: (progress: SolverProgress) => void
): Promise<SolveBundle> {
  const issues = validatePlannerInput(input);
  if (issues.length) {
    throw new PlannerError("INPUT_INVALID", "输入参数未通过校验。", issues.map((issue) => `${issue.path}: ${issue.message}`));
  }
  const sensitivityDays = [...new Set([input.quota.fullUseDays, ...input.quota.sensitivityDays])].sort((a, b) => a - b);
  const hasExpected = hasCompleteProbabilities(input);
  const total = sensitivityDays.length + (hasExpected ? 1 : 0);
  let completed = 0;
  onProgress?.({ phase: "计算主保底策略", completed, total });
  const robustPrimary = await solveOne(input, "robust", input.quota.fullUseDays);
  completed += 1;
  onProgress?.({ phase: hasExpected ? "计算主期望策略" : "计算速度敏感性", completed, total });
  const expected = hasExpected ? await solveOne(input, "expected", input.quota.fullUseDays) : null;
  if (expected) completed += 1;

  const sensitivity: SolveResult[] = [robustPrimary];
  for (const days of sensitivityDays) {
    if (days === input.quota.fullUseDays) continue;
    onProgress?.({ phase: `敏感性：${days} 天用完一份`, completed, total });
    sensitivity.push(await solveOne(input, "robust", days));
    completed += 1;
  }
  sensitivity.sort((left, right) => left.fullUseDays - right.fullUseDays);
  onProgress?.({ phase: "完成", completed: total, total });
  return {
    inputRevision,
    generatedAt: new Date().toISOString(),
    primaryDays: input.quota.fullUseDays,
    expected,
    robust: robustPrimary,
    sensitivity
  };
}

export function estimateModel(input: PlannerInput): {
  gridPoints: number;
  scenarios: number;
  variables: number;
  constraints: number;
} {
  const compiled = compilePlanningModel(input, "robust", input.quota.fullUseDays);
  return {
    gridPoints: compiled.grid.length,
    scenarios: compiled.scenarios.length,
    variables: compiled.estimatedVariables,
    constraints: compiled.estimatedConstraints
  };
}

export function scenarioUsageExpression(compiled: CompiledPlanningModel, scenarioIndex: number): Expression {
  const result = cloneExpression(compiled.usageByScenario[scenarioIndex]);
  addExpression(result, compiled.overwrittenByScenario[scenarioIndex], 0);
  return result;
}
