export type IsoInstant = string;
export type SolveMode = "expected" | "robust";
export type SolveStatus = "optimal" | "feasible" | "cancelled" | "error";

export interface QuotaSettings {
  capacity: number;
  initialBalance: number;
  nextNaturalResetAt: IsoInstant;
  cycleHours: number;
  fullUseDays: number;
  sensitivityDays: number[];
}

export interface ResetCard {
  id: string;
  name: string;
  availableAt: IsoInstant;
  expiresAt: IsoInstant;
  resetsNaturalClock: boolean;
}

export interface Task {
  id: string;
  name: string;
  availableAt: IsoInstant;
  deadlineAt: IsoInstant;
  quotaDemand: number;
  valuePerQuota: number;
  note?: string;
}

export interface EventOutcome {
  id: string;
  name: string;
  at: IsoInstant | null;
  resetsAllowance: boolean;
  resetsNaturalClock: boolean;
  probability: number | null;
}

export interface EventGroup {
  id: string;
  name: string;
  outcomes: EventOutcome[];
}

export interface SolverOptions {
  stepMinutes: 15 | 30 | 60 | 180;
  timeLimitSeconds: number;
  scenarioLimit: number;
}

export interface PlannerInput {
  schemaVersion: 1;
  timezone: string;
  horizonStart: IsoInstant;
  horizonEnd: IsoInstant;
  quota: QuotaSettings;
  cards: ResetCard[];
  tasks: Task[];
  eventGroups: EventGroup[];
  options: SolverOptions;
}

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface Scenario {
  id: string;
  name: string;
  outcomeByGroup: Record<string, string>;
  probability: number | null;
}

export type TimelineEventKind = "natural-reset" | "extra-reset" | "use-card" | "work";

export interface TimelineEvent {
  at: IsoInstant;
  kind: TimelineEventKind;
  title: string;
  detail: string;
  quotaAmount?: number;
}

export interface ScenarioMetrics {
  scenarioId: string;
  scenarioName: string;
  probability: number | null;
  weightedValue: number;
  totalUsed: number;
  overwrittenBalance: number;
  cardsUsed: string[];
  unusedCards: string[];
  taskUsage: Record<string, number>;
  timeline: TimelineEvent[];
}

export interface PolicyAction {
  at: IsoInstant;
  condition: string;
  cardId?: string;
  allocations: Array<{ taskId: string; quota: number }>;
}

export interface SolveResult {
  mode: SolveMode;
  status: SolveStatus;
  optimal: boolean;
  solverStatus: string;
  mipGap: number | null;
  durationMs: number;
  gridPoints: number;
  stepMinutes: number;
  fullUseDays: number;
  objectiveValue: number;
  totalUsed: number;
  worstCaseValue: number;
  expectedValue: number | null;
  scenarios: ScenarioMetrics[];
  policy: PolicyAction[];
  warnings: string[];
}

export interface SolveBundle {
  inputRevision: number;
  generatedAt: IsoInstant;
  primaryDays: number;
  expected: SolveResult | null;
  robust: SolveResult;
  sensitivity: SolveResult[];
}

export interface ProjectEnvelope {
  schemaVersion: 1;
  inputRevision: number;
  updatedAt: IsoInstant;
  input: PlannerInput;
  lastResult?: SolveBundle;
}

export interface SolverProgress {
  phase: string;
  completed: number;
  total: number;
}

export type WorkerRequest =
  | { type: "solve"; input: PlannerInput; inputRevision: number }
  | { type: "cancel" };

export type WorkerResponse =
  | { type: "progress"; progress: SolverProgress }
  | { type: "result"; result: SolveBundle }
  | { type: "error"; code: string; message: string; details?: string[] };
