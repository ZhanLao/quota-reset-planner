export class PlannerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: string[] = []
  ) {
    super(message);
    this.name = "PlannerError";
  }
}

export const ERROR_HELP: Record<string, string> = {
  INPUT_INVALID: "修正标红字段后重新求解。余额、时间窗和概率必须满足提示中的边界。",
  SCENARIO_LIMIT: "标记已经观察到的结果、合并重复事件，或把事件拆成多次敏感性分析。",
  MODEL_TOO_LARGE: "缩短规划时域、把时间步长调粗，或减少任务和不确定情景。",
  SOLVER_TIMEOUT: "可使用带最优间隙的可行方案，或调粗网格后重新求解以争取证明最优。",
  WASM_LOAD_FAILED: "确认页面通过 HTTPS 或 localhost 打开，并刷新 PWA 缓存；不要直接双击 index.html。",
  STORAGE_UNAVAILABLE: "当前结果只保留在内存中，请立即导出 JSON，避免关闭页面后丢失。",
  SCHEMA_UNSUPPORTED: "使用与本程序相同版本导出的 JSON；程序不会覆盖当前项目。"
};
