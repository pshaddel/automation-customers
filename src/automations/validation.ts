import type { ValidationProblem } from "../lib/errors";
import { getStepType } from "./steps/registry";
import { findTemplatePaths } from "./template";

export interface StepDefinition {
  key: string;
  stepType: string;
  label: string;
  config: Record<string, unknown>;
  next: Record<string, string>;
}

export interface GraphValidation {
  problems: ValidationProblem[];
  /** Key of the entry trigger, when there is exactly one. */
  entryKey?: string;
}

/**
 * Checks a version before it's published (drafts may be invalid while being edited).
 * Returns every problem at once so the editor can show them together.
 */
export function validateSteps(steps: StepDefinition[]): GraphValidation {
  const problems: ValidationProblem[] = [];
  const byKey = new Map(steps.map((step) => [step.key, step]));

  if (steps.length === 0) {
    return { problems: [{ problem: "The automation has no steps" }] };
  }

  const entries = steps.filter((step) => {
    const type = getStepType(step.stepType);
    return type?.kind === "trigger" && type.position === "entry";
  });
  if (entries.length !== 1)
    problems.push({
      problem: `Expected exactly one entry trigger, found ${entries.length}`,
    });
  const entryKey = entries.length === 1 ? entries[0]?.key : undefined;

  for (const step of steps) {
    const type = getStepType(step.stepType);
    if (!type) {
      problems.push({
        stepKey: step.key,
        problem: `Unknown step type '${step.stepType}'`,
      });
      continue;
    }

    const parsed = type.inputSchema.safeParse(step.config);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        problems.push({
          stepKey: step.key,
          problem: `config${issue.path.length ? `.${issue.path.join(".")}` : ""}: ${issue.message}`,
        });

    for (const [outcome, target] of Object.entries(step.next)) {
      if (outcome !== "error" && !type.outcomes.includes(outcome))
        problems.push({
          stepKey: step.key,
          problem: `next: '${outcome}' is not an outcome of ${step.stepType} (${type.outcomes.join(", ")})`,
        });
      const targetStep = byKey.get(target);
      if (!targetStep) {
        problems.push({
          stepKey: step.key,
          problem: `next.${outcome}: no step with key '${target}'`,
        });
        continue;
      }
      const targetType = getStepType(targetStep.stepType);
      if (targetType?.kind === "trigger" && targetType.position === "entry")
        problems.push({
          stepKey: step.key,
          problem: `next.${outcome}: '${target}' is an entry trigger and can't be reached mid-flow`,
        });
    }

    const paths = findTemplatePaths(step.config);
    if (step.key === entryKey && paths.length > 0)
      problems.push({
        stepKey: step.key,
        problem: "The entry trigger's config can't use templates",
      });
    for (const path of paths) {
      const [root, stepKey] = path.split(".");
      const valid =
        (root === "trigger" && path.length > "trigger".length) ||
        (root === "steps" && stepKey !== undefined && byKey.has(stepKey));
      if (!valid)
        problems.push({
          stepKey: step.key,
          problem: `Template {{${path}}} must reference trigger.* or steps.<existing key>.*`,
        });
    }
  }

  if (entryKey) {
    const reachable = new Set<string>([entryKey]);
    const queue = [entryKey];
    while (queue.length > 0) {
      const current = byKey.get(queue.shift() ?? "");
      for (const target of Object.values(current?.next ?? {}))
        if (byKey.has(target) && !reachable.has(target)) {
          reachable.add(target);
          queue.push(target);
        }
    }
    for (const step of steps)
      if (!reachable.has(step.key))
        problems.push({
          stepKey: step.key,
          problem: "Not reachable from the entry trigger",
        });
  }

  return { problems, entryKey };
}
