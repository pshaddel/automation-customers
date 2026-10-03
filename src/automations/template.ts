/**
 * `{{path.to.value}}` templates in step config, resolved against the run context
 * (`{ trigger: {...}, steps: { <key>: {...} } }`).
 *
 * A string that is exactly one template keeps the referenced value's type; a template
 * inside longer text is stringified. A path that doesn't resolve throws `TemplateError`.
 */

const TEMPLATE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const WHOLE_TEMPLATE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

export class TemplateError extends Error {
  constructor(public readonly path: string) {
    super(`Template value not found: {{${path}}}`);
    this.name = "TemplateError";
  }
}

function lookup(path: string, context: unknown): unknown {
  let current: unknown = context;
  for (const part of path.split(".")) {
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, part)
    )
      throw new TemplateError(path);
    current = (current as Record<string, unknown>)[part];
  }
  if (current === undefined) throw new TemplateError(path);
  return current;
}

export function resolveTemplates(value: unknown, context: unknown): unknown {
  if (typeof value === "string") {
    const whole = WHOLE_TEMPLATE.exec(value);
    if (whole?.[1]) return lookup(whole[1], context);
    return value.replace(TEMPLATE, (_, path: string) => {
      const resolved = lookup(path, context);
      return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value))
    return value.map((item) => resolveTemplates(item, context));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveTemplates(v, context)]),
    );
  return value;
}

/** Every template path used anywhere in `value`. */
export function findTemplatePaths(value: unknown): string[] {
  if (typeof value === "string")
    return [...value.matchAll(TEMPLATE)].map((m) => m[1] ?? "");
  if (Array.isArray(value)) return value.flatMap(findTemplatePaths);
  if (value !== null && typeof value === "object")
    return Object.values(value).flatMap(findTemplatePaths);
  return [];
}
