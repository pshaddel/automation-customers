import { describe, expect, test } from "bun:test";
import {
  findTemplatePaths,
  resolveTemplates,
  TemplateError,
} from "../template";

const context = {
  trigger: { accountId: "acc_1", contactId: "c_1", count: 3 },
  steps: { ask: { messageId: "m_1" } },
};

describe("resolveTemplates", () => {
  test("a whole-string template keeps the value's type", () => {
    expect(resolveTemplates("{{trigger.count}}", context)).toBe(3);
  });

  test("templates inside text are interpolated", () => {
    expect(
      resolveTemplates(
        "Hi {{ trigger.contactId }}, re {{steps.ask.messageId}}",
        context,
      ),
    ).toBe("Hi c_1, re m_1");
  });

  test("walks nested objects and arrays, leaving other values alone", () => {
    expect(
      resolveTemplates(
        {
          a: "{{trigger.accountId}}",
          b: ["{{steps.ask.messageId}}", 1],
          c: true,
        },
        context,
      ),
    ).toEqual({ a: "acc_1", b: ["m_1", 1], c: true });
  });

  test("a missing path throws TemplateError", () => {
    expect(() => resolveTemplates("{{steps.nope.id}}", context)).toThrow(
      TemplateError,
    );
  });

  test("does not resolve inherited properties", () => {
    expect(() => resolveTemplates("{{trigger.toString}}", context)).toThrow(
      TemplateError,
    );
  });
});

describe("findTemplatePaths", () => {
  test("collects every path", () => {
    expect(
      findTemplatePaths({
        a: "{{trigger.x}} and {{steps.y.z}}",
        b: ["{{trigger.w}}"],
      }),
    ).toEqual(["trigger.x", "steps.y.z", "trigger.w"]);
  });
});
