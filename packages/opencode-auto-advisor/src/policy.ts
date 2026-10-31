import type { Config } from "./config.js";
import type { Answer, Moment } from "./decisions.js";

export interface Reading {
  /** The most likely non-routine moment; `nonRoutine` says how likely any of them is. */
  readonly moment: Moment;
  /** 1 - P(routine). */
  readonly nonRoutine: number;
  /** Raw probability-weighted level index (0..4); never rounded. */
  readonly consequence: number;
}

export type Verdict =
  | { readonly consult: true; readonly reading: Reading }
  | { readonly consult: false; readonly reason: string; readonly reading?: Reading };

/** Reads the two answers; undefined when either is missing or the host declined it. */
export function read(answers: readonly Answer[]): Reading | undefined {
  const moment = answers.find((answer) => answer.name === "moment");
  const consequence = answers.find((answer) => answer.name === "consequence");
  if (moment?.type !== "choice" || consequence?.type !== "score") return undefined;
  if (typeof consequence.score !== "number") return undefined;
  const probabilities = moment.probabilities ?? [];
  const p = (value: Moment) => probabilities.find((item) => item.value === value)?.probability ?? 0;
  const candidates: Moment[] = ["approach", "stuck", "done"];
  const best = candidates.reduce((a, b) => (p(b) > p(a) ? b : a));
  const nonRoutine = 1 - p("routine");
  return {
    moment: best,
    nonRoutine,
    consequence: consequence.score,
  };
}

export function decide(input: {
  readonly answers: readonly Answer[];
  readonly routing: Config["routing"];
}): Verdict {
  const reading = read(input.answers);
  if (!reading) return { consult: false, reason: "unanswered" };
  if (reading.nonRoutine < input.routing.momentThreshold) {
    return { consult: false, reason: "routine", reading };
  }
  if (reading.consequence < input.routing.consequenceThreshold) {
    return { consult: false, reason: "low-consequence", reading };
  }
  return { consult: true, reading };
}
