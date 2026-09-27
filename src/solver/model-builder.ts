export type Sense = "<=" | ">=" | "=";
export type ObjectiveSense = "Maximize" | "Minimize";
export type Expression = Map<string, number>;

interface VariableSpec {
  lower: number;
  upper: number;
  binary: boolean;
}

interface ConstraintSpec {
  name: string;
  expression: Expression;
  sense: Sense;
  rhs: number;
}

function numberText(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`模型中出现非有限数值：${value}`);
  if (Math.abs(value) < 1e-12) return "0";
  return Number(value.toPrecision(12)).toString();
}

export function expression(entries: Array<[string, number]> = []): Expression {
  const result: Expression = new Map();
  entries.forEach(([name, coefficient]) => addTerm(result, name, coefficient));
  return result;
}

export function addTerm(target: Expression, variable: string, coefficient: number): void {
  if (Math.abs(coefficient) < 1e-12) return;
  const next = (target.get(variable) ?? 0) + coefficient;
  if (Math.abs(next) < 1e-12) target.delete(variable);
  else target.set(variable, next);
}

export function addExpression(target: Expression, source: Expression, scale = 1): void {
  source.forEach((coefficient, variable) => addTerm(target, variable, coefficient * scale));
}

export function cloneExpression(source: Expression): Expression {
  return new Map(source);
}

function renderExpression(value: Expression): string {
  const terms = [...value.entries()];
  if (!terms.length) return "0";
  return terms.map(([variable, coefficient], index) => {
    const sign = coefficient < 0 ? "-" : "+";
    const magnitude = Math.abs(coefficient);
    const body = `${magnitude === 1 ? "" : `${numberText(magnitude)} `}${variable}`;
    if (index === 0) return coefficient < 0 ? `- ${body}` : body;
    return `${sign} ${body}`;
  }).join(" ");
}

export class ModelBuilder {
  private readonly variables = new Map<string, VariableSpec>();
  private readonly constraints: ConstraintSpec[] = [];

  addContinuous(name: string, lower = 0, upper = Number.POSITIVE_INFINITY): string {
    this.assertNew(name);
    this.variables.set(name, { lower, upper, binary: false });
    return name;
  }

  addBinary(name: string): string {
    this.assertNew(name);
    this.variables.set(name, { lower: 0, upper: 1, binary: true });
    return name;
  }

  addConstraint(name: string, value: Expression, sense: Sense, rhs: number): void {
    this.constraints.push({ name, expression: cloneExpression(value), sense, rhs });
  }

  variableCount(): number {
    return this.variables.size;
  }

  constraintCount(): number {
    return this.constraints.length;
  }

  render(
    objectiveSense: ObjectiveSense,
    objective: Expression,
    extraConstraints: ConstraintSpec[] = []
  ): string {
    const lines: string[] = [objectiveSense, ` objective: ${renderExpression(objective)}`, "Subject To"];
    [...this.constraints, ...extraConstraints].forEach((constraint) => {
      lines.push(` ${constraint.name}: ${renderExpression(constraint.expression)} ${constraint.sense} ${numberText(constraint.rhs)}`);
    });
    lines.push("Bounds");
    this.variables.forEach((spec, name) => {
      if (spec.binary) return;
      const lower = Number.isFinite(spec.lower) ? numberText(spec.lower) : "-inf";
      const upper = Number.isFinite(spec.upper) ? numberText(spec.upper) : "+inf";
      lines.push(` ${lower} <= ${name} <= ${upper}`);
    });
    const binaries = [...this.variables.entries()].filter(([, spec]) => spec.binary).map(([name]) => name);
    if (binaries.length) {
      lines.push("Binaries");
      for (let index = 0; index < binaries.length; index += 40) {
        lines.push(` ${binaries.slice(index, index + 40).join(" ")}`);
      }
    }
    lines.push("End");
    return lines.join("\n");
  }

  static extraConstraint(name: string, value: Expression, sense: Sense, rhs: number): ConstraintSpec {
    return { name, expression: cloneExpression(value), sense, rhs };
  }

  private assertNew(name: string): void {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(`非法变量名：${name}`);
    if (this.variables.has(name)) throw new Error(`重复变量名：${name}`);
  }
}
