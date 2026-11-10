/** Decomposed clock time. All fields are non-negative integers. */
export interface TimeComponents {
  hours: number;
  minutes: number;
  seconds: number;
  millis: number;
}

/** Split a non-negative millisecond total into clock components. */
export function splitMs(totalMs: number): TimeComponents {
  if (totalMs < 0) throw new RangeError(`splitMs: negative input ${totalMs}`);
  const t = Math.floor(totalMs);
  return {
    hours: Math.floor(t / 3_600_000),
    minutes: Math.floor(t / 60_000) % 60,
    seconds: Math.floor(t / 1000) % 60,
    millis: t % 1000,
  };
}

/** Recombine clock components into a millisecond total. */
export function joinMs(components: TimeComponents): number {
  const { hours, minutes, seconds, millis } = components;
  return hours * 3_600_000 + minutes * 60_000 + seconds * 1000 + millis;
}
