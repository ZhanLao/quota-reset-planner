import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ERROR_HELP, PlannerError } from "./domain/errors";
import { createDemoInput } from "./domain/demo";
import type {
  EventGroup,
  EventOutcome,
  PlannerInput,
  ProjectEnvelope,
  ResetCard,
  SolveResult,
  Task,
  WorkerResponse
} from "./domain/types";
import { scenarioCount, validatePlannerInput } from "./domain/validation";
import { estimateModel } from "./solver/solve";
import {
  createEnvelope,
  exportProject,
  importProject,
  loadProject,
  saveProject
} from "./storage/project-store";
import { displayInstant, isoToLocalInput, localInputToIso, uid } from "./ui/datetime";
import "./styles.css";

type Mutator = (draft: PlannerInput) => void;

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function DateField({
  label,
  value,
  timezone,
  onChange
}: {
  label: string;
  value: string;
  timezone: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <input
        type="datetime-local"
        value={isoToLocalInput(value, timezone)}
        onChange={(event) => {
          if (!event.target.value) return;
          try { onChange(localInputToIso(event.target.value, timezone)); } catch { /* 浏览器原生输入会保留原值。 */ }
        }}
      />
    </Field>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step = "any",
  hint,
  onChange
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number | "any";
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(event.target.value === "" ? Number.NaN : Number(event.target.value))}
      />
    </Field>
  );
}

function CardEditor({ card, timezone, onChange, onRemove }: {
  card: ResetCard;
  timezone: string;
  onChange: (card: ResetCard) => void;
  onRemove: () => void;
}) {
  return (
    <article className="item-card">
      <div className="item-head">
        <input aria-label="卡片名称" value={card.name} onChange={(event) => onChange({ ...card, name: event.target.value })} />
        <button className="danger ghost" type="button" onClick={onRemove}>删除</button>
      </div>
      <div className="grid two">
        <DateField label="到账时刻" value={card.availableAt} timezone={timezone} onChange={(value) => onChange({ ...card, availableAt: value })} />
        <DateField label="严格失效时刻" value={card.expiresAt} timezone={timezone} onChange={(value) => onChange({ ...card, expiresAt: value })} />
      </div>
      <label className="check-row">
        <input type="checkbox" checked={card.resetsNaturalClock} onChange={(event) => onChange({ ...card, resetsNaturalClock: event.target.checked })} />
        用卡后把下一自然重置改为“用卡时刻 + 周期”
      </label>
    </article>
  );
}

function TaskEditor({ task, timezone, onChange, onRemove }: {
  task: Task;
  timezone: string;
  onChange: (task: Task) => void;
  onRemove: () => void;
}) {
  return (
    <article className="item-card">
      <div className="item-head">
        <input aria-label="任务名称" value={task.name} onChange={(event) => onChange({ ...task, name: event.target.value })} />
        <button className="danger ghost" type="button" onClick={onRemove}>删除</button>
      </div>
      <div className="grid two">
        <DateField label="可开始时刻" value={task.availableAt} timezone={timezone} onChange={(value) => onChange({ ...task, availableAt: value })} />
        <DateField label="截止时刻（不包含）" value={task.deadlineAt} timezone={timezone} onChange={(value) => onChange({ ...task, deadlineAt: value })} />
        <NumberField label="所需额度" value={task.quotaDemand} min={0.001} step={0.05} onChange={(value) => onChange({ ...task, quotaDemand: value })} />
        <NumberField label="单位额度价值" value={task.valuePerQuota} min={1} step={0.5} hint="普通使用的价值为 1；数值 5 表示这项任务每份额度的价值是普通使用的 5 倍。" onChange={(value) => onChange({ ...task, valuePerQuota: value })} />
      </div>
      <Field label="备注">
        <input value={task.note ?? ""} onChange={(event) => onChange({ ...task, note: event.target.value })} />
      </Field>
    </article>
  );
}

function OutcomeEditor({ outcome, timezone, onChange, onRemove }: {
  outcome: EventOutcome;
  timezone: string;
  onChange: (outcome: EventOutcome) => void;
  onRemove: () => void;
}) {
  return (
    <div className="outcome-row">
      <Field label="结果名称">
        <input value={outcome.name} onChange={(event) => onChange({ ...outcome, name: event.target.value })} />
      </Field>
      <Field label="发生时刻">
        <input
          type="datetime-local"
          value={outcome.at ? isoToLocalInput(outcome.at, timezone) : ""}
          onChange={(event) => onChange({
            ...outcome,
            at: event.target.value ? localInputToIso(event.target.value, timezone) : null
          })}
        />
      </Field>
      <Field label="概率（未知留空）">
        <input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={outcome.probability ?? ""}
          onChange={(event) => onChange({ ...outcome, probability: event.target.value === "" ? null : Number(event.target.value) })}
        />
      </Field>
      <label className="mini-check"><input type="checkbox" checked={outcome.resetsAllowance} onChange={(event) => onChange({ ...outcome, resetsAllowance: event.target.checked })} />刷新额度</label>
      <label className="mini-check"><input type="checkbox" checked={outcome.resetsNaturalClock} onChange={(event) => onChange({ ...outcome, resetsNaturalClock: event.target.checked })} />重开时钟</label>
      <button className="danger ghost compact" type="button" onClick={onRemove}>删除结果</button>
    </div>
  );
}

function EventGroupEditor({ group, timezone, onChange, onRemove }: {
  group: EventGroup;
  timezone: string;
  onChange: (group: EventGroup) => void;
  onRemove: () => void;
}) {
  const updateOutcome = (index: number, outcome: EventOutcome) => {
    const outcomes = [...group.outcomes];
    outcomes[index] = outcome;
    onChange({ ...group, outcomes });
  };
  return (
    <article className="item-card event-card">
      <div className="item-head">
        <input aria-label="事件组名称" value={group.name} onChange={(event) => onChange({ ...group, name: event.target.value })} />
        <button className="danger ghost" type="button" onClick={onRemove}>删除事件组</button>
      </div>
      <p className="micro-copy">同组结果互斥；“不发生”结果把发生时刻留空。未来未观察前，所有结果共享同一当前动作。</p>
      {group.outcomes.map((outcome, index) => (
        <OutcomeEditor
          key={outcome.id}
          outcome={outcome}
          timezone={timezone}
          onChange={(value) => updateOutcome(index, value)}
          onRemove={() => onChange({ ...group, outcomes: group.outcomes.filter((_, candidate) => candidate !== index) })}
        />
      ))}
      <button className="ghost" type="button" onClick={() => onChange({
        ...group,
        outcomes: [...group.outcomes, {
          id: uid("outcome"),
          name: "新结果",
          at: null,
          resetsAllowance: false,
          resetsNaturalClock: false,
          probability: null
        }]
      })}>+ 添加结果</button>
    </article>
  );
}

function ResultCard({ result, timezone, title }: { result: SolveResult; timezone: string; title: string }) {
  const nextAction = result.policy[0];
  return (
    <article className="result-card">
      <div className="result-title">
        <div>
          <span className={`status ${result.optimal ? "ok" : "warn"}`}>{result.optimal ? "已证明最优" : "限时可行"}</span>
          <h3>{title}</h3>
        </div>
        <div className="big-number">{result.totalUsed.toFixed(3)}<small> 份额度</small></div>
      </div>
      <div className="metric-grid">
        <div><span>最坏价值</span><strong>{result.worstCaseValue.toFixed(3)}</strong></div>
        <div><span>期望价值</span><strong>{result.expectedValue === null ? "概率未知" : result.expectedValue.toFixed(3)}</strong></div>
        <div><span>网格</span><strong>{result.stepMinutes} 分钟</strong></div>
        <div><span>耗时</span><strong>{(result.durationMs / 1000).toFixed(2)} 秒</strong></div>
      </div>
      <div className="recommendation">
        <span>下一项策略动作</span>
        {nextAction ? (
          <strong>
            {displayInstant(nextAction.at, timezone)} · {nextAction.cardId ? `使用 ${nextAction.cardId}` : "继续分配额度"}
          </strong>
        ) : <strong>当前无须用卡或分配额度</strong>}
        {nextAction && <small>条件：{nextAction.condition}</small>}
      </div>
      {result.warnings.map((warning) => <p className="warning-line" key={warning}>{warning}</p>)}
      <div className="scenario-list">
        {result.scenarios.map((scenario) => (
          <details key={scenario.scenarioId}>
            <summary>
              <span>{scenario.scenarioName}</span>
              <b>{scenario.totalUsed.toFixed(3)} 份 · 价值 {scenario.weightedValue.toFixed(3)}</b>
            </summary>
            <div className="scenario-body">
              <p>覆盖损失：{scenario.overwrittenBalance.toFixed(3)}；已用卡：{scenario.cardsUsed.join("、") || "无"}</p>
              <ol className="timeline">
                {scenario.timeline.map((event, index) => (
                  <li key={`${event.at}-${event.kind}-${index}`}>
                    <time>{displayInstant(event.at, timezone)}</time>
                    <div><strong>{event.title}</strong><span>{event.detail}</span></div>
                  </li>
                ))}
              </ol>
            </div>
          </details>
        ))}
      </div>
    </article>
  );
}

export default function App() {
  const [project, setProject] = useState<ProjectEnvelope>(() => createEnvelope(createDemoInput()));
  const [loaded, setLoaded] = useState(false);
  const [persistent, setPersistent] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("尚未求解");
  const [error, setError] = useState<{ message: string; details: string[]; help?: string } | null>(null);
  const [estimate, setEstimate] = useState<string>("");
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const issues = useMemo(() => validatePlannerInput(project.input), [project.input]);
  const stale = Boolean(project.lastResult && project.lastResult.inputRevision !== project.inputRevision);

  useEffect(() => {
    loadProject().then(({ project: stored, persistent: canPersist }) => {
      if (stored) setProject(stored);
      setPersistent(canPersist);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(async () => setPersistent(await saveProject(project)), 250);
    return () => window.clearTimeout(timer);
  }, [project, loaded]);

  useEffect(() => {
    const install = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const update = () => setProgress("发现新版本，刷新页面后更新离线资源。");
    const offline = () => setProgress("离线资源已准备好。");
    window.addEventListener("beforeinstallprompt", install);
    window.addEventListener("quota-pwa-update", update);
    window.addEventListener("quota-pwa-offline", offline);
    return () => {
      window.removeEventListener("beforeinstallprompt", install);
      window.removeEventListener("quota-pwa-update", update);
      window.removeEventListener("quota-pwa-offline", offline);
    };
  }, []);

  const updateInput = (mutator: Mutator) => {
    setProject((current) => {
      const input = structuredClone(current.input);
      mutator(input);
      return {
        ...current,
        input,
        inputRevision: current.inputRevision + 1,
        updatedAt: new Date().toISOString()
      };
    });
    setEstimate("");
  };

  const solve = () => {
    if (issues.length) {
      setError({ message: "输入参数未通过校验。", details: issues.map((issue) => `${issue.path}：${issue.message}`), help: ERROR_HELP.INPUT_INVALID });
      return;
    }
    setError(null);
    setRunning(true);
    setProgress("正在加载本地求解器…");
    const worker = new Worker(new URL("./solver/solver.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.type === "progress") {
        setProgress(`${event.data.progress.phase}（${event.data.progress.completed}/${event.data.progress.total}）`);
        return;
      }
      if (event.data.type === "result") {
        const result = event.data.result;
        setProject((current) => ({ ...current, lastResult: result }));
        setRunning(false);
        setProgress("求解完成");
        worker.terminate();
        workerRef.current = null;
        return;
      }
      setError({ message: event.data.message, details: event.data.details ?? [], help: ERROR_HELP[event.data.code] });
      setRunning(false);
      setProgress("求解失败");
      worker.terminate();
      workerRef.current = null;
    };
    worker.onerror = (event) => {
      setError({ message: "求解 Worker 异常。", details: [event.message], help: ERROR_HELP.WASM_LOAD_FAILED });
      setRunning(false);
      worker.terminate();
      workerRef.current = null;
    };
    worker.postMessage({ type: "solve", input: project.input, inputRevision: project.inputRevision });
  };

  const cancel = () => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setRunning(false);
    setProgress("已取消；模型在独立 Worker 中终止，当前输入未改变。");
  };

  const input = project.input;
  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <span className="eyebrow">LOCAL-FIRST · NON-ANTICIPATIVE</span>
          <h1>额度重置策略工作台</h1>
          <p>把余额、自然周期、到期卡片、高价值任务和不确定活动放进同一个可解释模型。</p>
        </div>
        <div className="hero-actions">
          {installPrompt && <button type="button" onClick={async () => { await installPrompt.prompt(); setInstallPrompt(null); }}>安装到设备</button>}
          <button className="ghost" type="button" onClick={() => exportProject(project)}>导出 JSON</button>
          <button className="ghost" type="button" onClick={() => fileRef.current?.click()}>导入 JSON</button>
          <input
            ref={fileRef}
            hidden
            type="file"
            accept="application/json"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              try { setProject(await importProject(file)); setError(null); }
              catch (caught) {
                const value = caught instanceof PlannerError ? caught : new PlannerError("SCHEMA_UNSUPPORTED", String(caught));
                setError({ message: value.message, details: value.details, help: ERROR_HELP[value.code] });
              } finally { event.target.value = ""; }
            }}
          />
        </div>
      </header>

      {!persistent && <div className="banner danger-banner">浏览器存储不可用：当前数据只在本次页面中保留，请立即导出 JSON。</div>}
      {stale && <div className="banner stale-banner">参数已修改，下方旧结果仅供参考；请重新求解。</div>}
      <div className="status-strip"><span className={running ? "pulse" : "dot"} />{progress}</div>

      <main>
        <section className="panel">
          <div className="section-head"><div><span>01</span><h2>真实当前状态</h2></div><p>不要只填“上次何时重置”；当前余额和下一自然日期都是独立状态。</p></div>
          <div className="grid three">
            <Field label="项目时区"><input value={input.timezone} onChange={(event) => updateInput((draft) => { draft.timezone = event.target.value; })} /></Field>
            <DateField label="规划起点" value={input.horizonStart} timezone={input.timezone} onChange={(value) => updateInput((draft) => { draft.horizonStart = value; })} />
            <DateField label="订阅结束（不包含）" value={input.horizonEnd} timezone={input.timezone} onChange={(value) => updateInput((draft) => { draft.horizonEnd = value; })} />
            <NumberField label="满额容量" value={input.quota.capacity} min={0.01} step={0.1} onChange={(value) => updateInput((draft) => { draft.quota.capacity = value; })} />
            <NumberField label="当前余额" value={input.quota.initialBalance} min={0} step={0.01} onChange={(value) => updateInput((draft) => { draft.quota.initialBalance = value; })} />
            <DateField label="下一自然重置" value={input.quota.nextNaturalResetAt} timezone={input.timezone} onChange={(value) => updateInput((draft) => { draft.quota.nextNaturalResetAt = value; })} />
            <NumberField label="自然周期（小时）" value={input.quota.cycleHours} min={1} step={1} hint="7 天填写 168。" onChange={(value) => updateInput((draft) => { draft.quota.cycleHours = value; })} />
            <NumberField label="预计几天用完一份" value={input.quota.fullUseDays} min={0.1} step={0.1} onChange={(value) => updateInput((draft) => { draft.quota.fullUseDays = value; })} />
            <Field label="敏感性天数" hint="用英文逗号分隔，例如 2,2.5,3。">
              <input value={input.quota.sensitivityDays.join(",")} onChange={(event) => updateInput((draft) => {
                draft.quota.sensitivityDays = event.target.value.split(",").map(Number).filter((value) => Number.isFinite(value));
              })} />
            </Field>
          </div>
        </section>

        <section className="panel">
          <div className="section-head"><div><span>02</span><h2>重置卡</h2></div><button type="button" onClick={() => updateInput((draft) => draft.cards.push({
            id: uid("card"), name: "新重置卡", availableAt: draft.horizonStart, expiresAt: draft.horizonEnd, resetsNaturalClock: true
          }))}>+ 添加卡片</button></div>
          <div className="stack">{input.cards.map((card, index) => <CardEditor key={card.id} card={card} timezone={input.timezone} onChange={(value) => updateInput((draft) => { draft.cards[index] = value; })} onRemove={() => updateInput((draft) => { draft.cards.splice(index, 1); })} />)}</div>
        </section>

        <section className="panel">
          <div className="section-head"><div><span>03</span><h2>高价值任务</h2></div><button type="button" onClick={() => updateInput((draft) => draft.tasks.push({
            id: uid("task"), name: "新任务", availableAt: draft.horizonStart, deadlineAt: draft.horizonEnd, quotaDemand: 0.5, valuePerQuota: 2
          }))}>+ 添加任务</button></div>
          <div className="stack">{input.tasks.map((task, index) => <TaskEditor key={task.id} task={task} timezone={input.timezone} onChange={(value) => updateInput((draft) => { draft.tasks[index] = value; })} onRemove={() => updateInput((draft) => { draft.tasks.splice(index, 1); })} />)}</div>
        </section>

        <section className="panel">
          <div className="section-head"><div><span>04</span><h2>不确定额外事件</h2></div><button type="button" onClick={() => updateInput((draft) => draft.eventGroups.push({
            id: uid("event"), name: "新不确定事件", outcomes: [
              { id: uid("outcome"), name: "发生", at: draft.horizonStart, resetsAllowance: true, resetsNaturalClock: true, probability: null },
              { id: uid("outcome"), name: "不发生", at: null, resetsAllowance: false, resetsNaturalClock: false, probability: null }
            ]
          }))}>+ 添加事件组</button></div>
          <div className="stack">{input.eventGroups.map((group, index) => <EventGroupEditor key={group.id} group={group} timezone={input.timezone} onChange={(value) => updateInput((draft) => { draft.eventGroups[index] = value; })} onRemove={() => updateInput((draft) => { draft.eventGroups.splice(index, 1); })} />)}</div>
        </section>

        <section className="panel solve-panel">
          <div className="section-head"><div><span>05</span><h2>求解与精度</h2></div><p>输入边界精确保留；手动用卡只能落在所选时间网格。</p></div>
          <div className="grid three">
            <Field label="时间步长">
              <select value={input.options.stepMinutes} onChange={(event) => updateInput((draft) => { draft.options.stepMinutes = Number(event.target.value) as 15 | 30 | 60 | 180; })}>
                <option value={15}>15 分钟</option><option value={30}>30 分钟</option><option value={60}>1 小时（推荐）</option><option value={180}>3 小时</option>
              </select>
            </Field>
            <NumberField label="单次求解限时（秒）" value={input.options.timeLimitSeconds} min={1} max={60} step={1} onChange={(value) => updateInput((draft) => { draft.options.timeLimitSeconds = value; })} />
            <div className="model-count"><span>情景叶</span><strong>{scenarioCount(input)} / {input.options.scenarioLimit}</strong></div>
          </div>
          {issues.length > 0 && <div className="issue-box"><strong>需要先修正：</strong><ul>{issues.map((issue) => <li key={`${issue.path}-${issue.code}`}>{issue.path}：{issue.message}</li>)}</ul></div>}
          {estimate && <p className="estimate">{estimate}</p>}
          <div className="solve-actions">
            <button className="ghost" type="button" disabled={running || Boolean(issues.length)} onClick={() => {
              try {
                const model = estimateModel(input);
                setEstimate(`${model.scenarios} 个情景、${model.gridPoints} 个时间点，约 ${model.variables.toLocaleString()} 个变量、${model.constraints.toLocaleString()} 条约束。`);
              } catch (caught) {
                const value = caught instanceof PlannerError ? caught : new PlannerError("MODEL_TOO_LARGE", String(caught));
                setError({ message: value.message, details: value.details, help: ERROR_HELP[value.code] });
              }
            }}>预估模型</button>
            {running ? <button className="danger" type="button" onClick={cancel}>取消求解</button> : <button className="primary" type="button" disabled={Boolean(issues.length)} onClick={solve}>计算最优策略</button>}
          </div>
        </section>

        {error && <section className="error-panel"><h2>{error.message}</h2>{error.help && <p>{error.help}</p>}<ul>{error.details.map((detail) => <li key={detail}>{detail}</li>)}</ul></section>}

        {project.lastResult && <section className={`results ${stale ? "stale" : ""}`}>
          <div className="section-head"><div><span>06</span><h2>策略结果</h2></div><p>保底策略先保护最坏情景；概率完整时另给期望最优。</p></div>
          <div className="result-stack">
            <ResultCard result={project.lastResult.robust} timezone={input.timezone} title="最坏情形保底策略" />
            {project.lastResult.expected && <ResultCard result={project.lastResult.expected} timezone={input.timezone} title="概率加权期望策略" />}
          </div>
          <article className="sensitivity-card">
            <h3>使用速度敏感性</h3>
            <table><thead><tr><th>用完一份</th><th>保底使用量</th><th>最坏价值</th><th>状态</th></tr></thead><tbody>
              {project.lastResult.sensitivity.map((result) => <tr key={result.fullUseDays}><td>{result.fullUseDays} 天</td><td>{result.totalUsed.toFixed(3)}</td><td>{result.worstCaseValue.toFixed(3)}</td><td>{result.optimal ? "最优" : "可行"}</td></tr>)}
            </tbody></table>
          </article>
        </section>}
      </main>
      <footer><p>所有计划默认只保存在本机浏览器。工具不读取账号、不自动点击重置，也不能替代平台官方规则。</p></footer>
    </div>
  );
}
