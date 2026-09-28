import type { EventGroup, EventOutcome, PlannerInput, Scenario } from "../domain/types";
import { toMs } from "./time-grid";

interface PartialScenario {
  outcomes: EventOutcome[];
  outcomeByGroup: Record<string, string>;
  names: string[];
  probability: number | null;
}

export function enumerateScenarios(input: PlannerInput): Scenario[] {
  let partials: PartialScenario[] = [{ outcomes: [], outcomeByGroup: {}, names: [], probability: 1 }];
  input.eventGroups.forEach((group) => {
    partials = partials.flatMap((partial) => group.outcomes.map((outcome) => ({
      outcomes: [...partial.outcomes, outcome],
      outcomeByGroup: { ...partial.outcomeByGroup, [group.id]: outcome.id },
      names: [...partial.names, `${group.name}：${outcome.name}`],
      probability: partial.probability === null || outcome.probability === null
        ? null
        : partial.probability * outcome.probability
    })));
  });
  if (!input.eventGroups.length) return [{ id: "scenario-0", name: "确定情景", outcomeByGroup: {}, probability: 1 }];
  return partials.map((partial, index) => ({
    id: `scenario-${index}`,
    name: partial.names.join("；"),
    outcomeByGroup: partial.outcomeByGroup,
    probability: partial.probability
  }));
}

export function selectedOutcome(group: EventGroup, scenario: Scenario): EventOutcome {
  const id = scenario.outcomeByGroup[group.id];
  const outcome = group.outcomes.find((candidate) => candidate.id === id);
  if (!outcome) throw new Error(`情景 ${scenario.id} 缺少事件组 ${group.id} 的结果。`);
  return outcome;
}

export function observationKey(input: PlannerInput, scenario: Scenario, at: number): string {
  const pieces = input.eventGroups.map((group) => {
    const selected = selectedOutcome(group, scenario);
    const candidateTimes = group.outcomes
      .map((outcome) => outcome.at === null ? null : toMs(outcome.at))
      .filter((value): value is number => value !== null);
    const lastPossibleTime = candidateTimes.length ? Math.max(...candidateTimes) : -Infinity;
    if (selected.at !== null && toMs(selected.at) <= at) return `${group.id}:${selected.id}`;
    if (at >= lastPossibleTime) return `${group.id}:${selected.id}`;
    return `${group.id}:pending`;
  });
  return pieces.join("|") || "certain";
}

export function conditionLabel(input: PlannerInput, key: string): string {
  if (key === "certain") return "所有情况";
  return key.split("|").map((piece) => {
    const [groupId, outcomeId] = piece.split(":");
    const group = input.eventGroups.find((candidate) => candidate.id === groupId);
    if (!group) return piece;
    if (outcomeId === "pending") return `${group.name}尚未揭晓`;
    const outcome = group.outcomes.find((candidate) => candidate.id === outcomeId);
    return outcome ? `若${group.name}：${outcome.name}` : piece;
  }).join("；");
}

export function exogenousEventAt(
  input: PlannerInput,
  scenario: Scenario,
  at: number
): {
  resetsAllowance: boolean;
  resetsNaturalClock: boolean;
  names: string[];
  forcedNames: string[];
  forcedResetsNaturalClock: boolean;
  uncertainResetsAllowance: boolean;
  uncertainResetsNaturalClock: boolean;
} {
  let resetsAllowance = false;
  let resetsNaturalClock = false;
  let forcedResetsNaturalClock = false;
  let uncertainResetsAllowance = false;
  let uncertainResetsNaturalClock = false;
  const names: string[] = [];
  const forcedNames: string[] = [];
  input.forcedResets.forEach((reset) => {
    if (toMs(reset.at) !== at) return;
    resetsAllowance = true;
    resetsNaturalClock ||= reset.resetsNaturalClock;
    forcedResetsNaturalClock ||= reset.resetsNaturalClock;
    forcedNames.push(reset.name);
  });
  input.eventGroups.forEach((group) => {
    const outcome = selectedOutcome(group, scenario);
    if (outcome.at !== null && toMs(outcome.at) === at) {
      resetsAllowance ||= outcome.resetsAllowance;
      resetsNaturalClock ||= outcome.resetsNaturalClock;
      uncertainResetsAllowance ||= outcome.resetsAllowance;
      uncertainResetsNaturalClock ||= outcome.resetsNaturalClock;
      names.push(`${group.name}：${outcome.name}`);
    }
  });
  return {
    resetsAllowance,
    resetsNaturalClock,
    names,
    forcedNames,
    forcedResetsNaturalClock,
    uncertainResetsAllowance,
    uncertainResetsNaturalClock
  };
}
