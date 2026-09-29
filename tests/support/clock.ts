import type { Clock } from '@/server/domain/clock';

export class MutableClock implements Clock {
  #now: number;

  constructor(start = Date.parse('2026-01-01T00:00:00Z')) {
    this.#now = start;
  }

  now(): Date {
    return new Date(this.#now);
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}
