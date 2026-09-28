import type { PlannerInput } from "../src/domain/types";
import { buildTimeGrid, DAY_MS, HOUR_MS, toMs } from "../src/solver/time-grid";

interface State {
  balance: number;
  nextNatural: number;
  usedMask: number;
}

export function bruteForceMaximumUsage(input: PlannerInput, fullUseDays: number): number {
  const grid = buildTimeGrid(input);
  const capacity = 1;
  const cycle = input.quota.cycleHours * HOUR_MS;
  const ratePerDay = capacity / fullUseDays;
  const memo = new Map<string, number>();

  const visit = (timeIndex: number, incoming: State): number => {
    if (timeIndex >= grid.length - 1) return 0;
    const at = grid[timeIndex];
    const state = { ...incoming };
    if (at === state.nextNatural) {
      state.balance = capacity;
      state.nextNatural = at + cycle;
    }
    const key = `${timeIndex}|${state.balance.toFixed(8)}|${state.nextNatural}|${state.usedMask}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    const choices: Array<number | null> = [null];
    input.cards.forEach((card, cardIndex) => {
      const available = toMs(card.availableAt) <= at && at < toMs(card.expiresAt);
      if (available && (state.usedMask & (1 << cardIndex)) === 0) choices.push(cardIndex);
    });
    let best = 0;
    for (const cardIndex of choices) {
      const next = { ...state };
      if (cardIndex !== null) {
        next.balance = capacity;
        next.usedMask |= 1 << cardIndex;
        if (input.cards[cardIndex].resetsNaturalClock) next.nextNatural = at + cycle;
      }
      const possible = ratePerDay * ((grid[timeIndex + 1] - at) / DAY_MS);
      const consumed = Math.min(next.balance, possible);
      next.balance -= consumed;
      best = Math.max(best, consumed + visit(timeIndex + 1, next));
    }
    memo.set(key, best);
    return best;
  };

  return visit(0, {
    balance: input.quota.initialRemainingPercent / 100,
    nextNatural: toMs(input.quota.nextNaturalResetAt),
    usedMask: 0
  }) * 100;
}
