// Every time-dependent decision (calculateTime, staleness checks) goes through a Clock,
// so tests and demos can pin "now" to 11:55pm or fast-forward 10 minutes.
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  private t: number;
  constructor(start: Date | string) {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  advanceMinutes(min: number): void {
    this.t += min * 60_000;
  }
}
