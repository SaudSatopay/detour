import { classify } from "../agent/models";

/** A model arm that failed only because no free model could answer: the run waits for the quotas instead of recording it. */
export const NO_MODEL = /No free model can answer|No model is configured/;

/**
 * Whether a recorded error is about the free models' availability (no model, a spent quota, a rate limit, a retired
 * model) rather than the arm's own work. Such an arm did not really run: a reopened run runs it again and the summary
 * leaves it out. A timeout or a tool's failure stays a wrong answer.
 */
export function unavailable(error: string): boolean {
  return NO_MODEL.test(error) || classify(new Error(error)) !== "other";
}
