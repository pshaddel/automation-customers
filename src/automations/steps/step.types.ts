import type { ZodType } from "zod";
import type { SocialMediaClient } from "../../social-media/social-media.client";
import type {
  SocialEvent,
  SocialEventType,
} from "../../social-media/social-media.events";

/**
 * Step implementations are pure: input in, output out (or throw). They never touch the
 * database, the queue or the run's status; the step runner does that around them.
 *
 * Methods (not arrow properties) are used on purpose: method parameters are bivariant,
 * so a concrete `ActionStep<SendDmInput>` fits the registry's `ActionStep<unknown>`.
 */

export interface StepContext {
  runId: string;
  sequence: number;
  attempt: number;
  /** `<runId>-<sequence>`: pass to platform calls so retries can be deduplicated. */
  idempotencyKey: string;
  socialMedia: SocialMediaClient;
}

export interface StepResult<Output> {
  outcome: string;
  output: Output;
}

interface StepBase<Input> {
  /** Permanent id stored in automation_steps.step_type. Never rename. */
  type: string;
  description: string;
  /** Validates config at publish and the template-resolved input before execution. */
  inputSchema: ZodType<Input>;
  /** Outcomes this step can finish with; `next` may only use these (plus `error`). */
  outcomes: readonly string[];
}

export interface ActionStep<Input = unknown, Output = unknown>
  extends StepBase<Input> {
  kind: "action";
  /** Throw to fail (retried); throw BullMQ's UnrecoverableError to fail without retrying. */
  execute(input: Input, ctx: StepContext): Promise<StepResult<Output>>;
}

export interface TriggerStep<
  Input = unknown,
  Event extends SocialEvent = SocialEvent,
  Output = unknown,
> extends StepBase<Input> {
  kind: "trigger";
  eventType: Event["type"] & SocialEventType;
  /** `entry` = only as the first step (starts runs); `wait` = only mid-flow (pauses a run). */
  position: "entry" | "wait";
  /** Key a listener for this input is stored under. */
  correlationKey(input: Input): string;
  /** Keys an incoming event can match; must use the same format as `correlationKey`. */
  eventKeys(event: Event): string[];
  /** Output when the event matches this input, or null. */
  match(event: Event, input: Input): Output | null;
  /** Who a run started by this event is about; used to dedupe active runs. */
  subjectKey(event: Event): string;
}

export type AnyStep = ActionStep | TriggerStep;
