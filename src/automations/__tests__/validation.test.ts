import { describe, expect, test } from "bun:test";
import { pricingExampleSteps } from "../pricing-example";
import { type StepDefinition, validateSteps } from "../validation";

const valid = () => pricingExampleSteps("acc_1");

function problemsOf(steps: StepDefinition[]): string[] {
  return validateSteps(steps).problems.map(
    (p) => `${p.stepKey ?? "-"}: ${p.problem}`,
  );
}

function edit(
  steps: StepDefinition[],
  key: string,
  patch: Partial<StepDefinition>,
): StepDefinition[] {
  return steps.map((s) => (s.key === key ? { ...s, ...patch } : s));
}

describe("validateSteps", () => {
  test("the pricing example is valid", () => {
    expect(validateSteps(valid())).toEqual({
      problems: [],
      entryKey: "trigger",
    });
  });

  test("no steps", () => {
    expect(problemsOf([])).toEqual(["-: The automation has no steps"]);
  });

  test("needs exactly one entry trigger", () => {
    const steps = valid().filter((s) => s.key !== "trigger");
    expect(problemsOf(steps)).toContain(
      "-: Expected exactly one entry trigger, found 0",
    );
  });

  test("unknown step type", () => {
    expect(problemsOf(edit(valid(), "reply", { stepType: "nope" }))).toContain(
      "reply: Unknown step type 'nope'",
    );
  });

  test("invalid config", () => {
    const problems = problemsOf(
      edit(valid(), "wait_email", {
        config: { accountId: "a", contactId: "c", match: "phone" },
      }),
    );
    expect(problems.some((p) => p.startsWith("wait_email: config.match"))).toBe(
      true,
    );
  });

  test("unknown outcome and dangling target", () => {
    const problems = problemsOf(
      edit(valid(), "reply", { next: { ok: "ask", maybe: "ghost" } }),
    );
    expect(problems).toContain(
      "reply: next: 'maybe' is not an outcome of reply_to_comment (ok)",
    );
    expect(problems).toContain("reply: next.maybe: no step with key 'ghost'");
  });

  test("error branch is allowed", () => {
    expect(
      problemsOf(
        edit(valid(), "ask", {
          next: { ok: "wait_email", error: "send_link" },
        }),
      ),
    ).toEqual([]);
  });

  test("unreachable steps", () => {
    expect(problemsOf(edit(valid(), "ask", { next: {} }))).toEqual([
      "wait_email: Not reachable from the entry trigger",
      "send_link: Not reachable from the entry trigger",
    ]);
  });

  test("the entry trigger can't be a target", () => {
    expect(
      problemsOf(edit(valid(), "send_link", { next: { ok: "trigger" } })),
    ).toContain(
      "send_link: next.ok: 'trigger' is an entry trigger and can't be reached mid-flow",
    );
  });

  test("templates must reference trigger or an existing step", () => {
    const problems = problemsOf(
      edit(valid(), "send_link", {
        config: {
          accountId: "{{trigger.accountId}}",
          contactId: "{{steps.ghost.id}}",
          text: "x",
        },
      }),
    );
    expect(problems).toContain(
      "send_link: Template {{steps.ghost.id}} must reference trigger.* or steps.<existing key>.*",
    );
  });

  test("entry trigger config can't use templates", () => {
    expect(
      problemsOf(
        edit(valid(), "trigger", {
          config: { accountId: "{{trigger.accountId}}", matchMode: "any" },
        }),
      ),
    ).toContain("trigger: The entry trigger's config can't use templates");
  });

  test("loops are allowed", () => {
    expect(
      problemsOf(edit(valid(), "send_link", { next: { ok: "wait_email" } })),
    ).toEqual([]);
  });
});
