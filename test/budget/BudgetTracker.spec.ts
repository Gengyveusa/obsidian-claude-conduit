import { beforeEach, describe, expect, it } from 'vitest';

import {
  BudgetTracker,
  formatDay,
  type BudgetLimits,
  type BudgetPersistence,
  type BudgetState,
} from '../../src/budget/BudgetTracker';

class InMemoryPersistence implements BudgetPersistence {
  state: BudgetState | null = null;
  saves = 0;

  load(): Promise<BudgetState | null> {
    return Promise.resolve(this.state ? { ...this.state } : null);
  }

  save(state: BudgetState): Promise<void> {
    this.state = { ...state };
    this.saves += 1;
    return Promise.resolve();
  }
}

const PT = 'America/Los_Angeles';

const limits: BudgetLimits = {
  maxTokensPerDay: 100_000,
  maxDollarsPerDay: 5,
  tz: PT,
};

let mockNow: Date;
function mockClock(): Date {
  return mockNow;
}

beforeEach(() => {
  // 2026-05-04 12:00 PT = 2026-05-04 19:00 UTC
  mockNow = new Date('2026-05-04T19:00:00Z');
});

describe('BudgetTracker', () => {
  it('initializes a fresh state when no persisted state exists', async () => {
    const persistence = new InMemoryPersistence();
    const tracker = await BudgetTracker.load(persistence, limits, mockClock);
    expect(tracker.snapshot()).toEqual({
      day: '2026-05-04',
      tokens_input: 0,
      tokens_output: 0,
      dollars_estimated: 0,
      tz: PT,
    });
    expect(persistence.saves).toBe(1); // initial save
  });

  it('reuses persisted state for the same day + tz', async () => {
    const persistence = new InMemoryPersistence();
    persistence.state = {
      day: '2026-05-04',
      tokens_input: 1000,
      tokens_output: 500,
      dollars_estimated: 0.05,
      tz: PT,
    };
    const tracker = await BudgetTracker.load(persistence, limits, mockClock);
    expect(tracker.snapshot().tokens_input).toBe(1000);
    expect(persistence.saves).toBe(0); // no resave on reuse
  });

  it('zeroes state when persisted day is in the past', async () => {
    const persistence = new InMemoryPersistence();
    persistence.state = {
      day: '2026-05-03',
      tokens_input: 99_999,
      tokens_output: 0,
      dollars_estimated: 0,
      tz: PT,
    };
    const tracker = await BudgetTracker.load(persistence, limits, mockClock);
    expect(tracker.snapshot().day).toBe('2026-05-04');
    expect(tracker.snapshot().tokens_input).toBe(0);
  });

  it('commit() accumulates and persists', async () => {
    const persistence = new InMemoryPersistence();
    const tracker = await BudgetTracker.load(persistence, limits, mockClock);
    await tracker.commit({ tokensIn: 1000, tokensOut: 500, costUsd: 0.012 });
    await tracker.commit({ tokensIn: 200, tokensOut: 50, costUsd: 0.003 });
    const snap = tracker.snapshot();
    expect(snap.tokens_input).toBe(1200);
    expect(snap.tokens_output).toBe(550);
    expect(snap.dollars_estimated).toBeCloseTo(0.015, 6);
    expect(persistence.state?.tokens_input).toBe(1200);
  });

  it('assertAvailable() throws when token cap would be exceeded', async () => {
    const persistence = new InMemoryPersistence();
    const tracker = await BudgetTracker.load(persistence, limits, mockClock);
    await tracker.commit({ tokensIn: 95_000, tokensOut: 0, costUsd: 0 });
    expect(() => tracker.assertAvailable(10_000)).toThrow(/daily token cap reached/);
    expect(() => tracker.assertAvailable(4096)).not.toThrow();
  });

  it('assertAvailable() throws when dollar cap is already exceeded', async () => {
    const persistence = new InMemoryPersistence();
    const tracker = await BudgetTracker.load(persistence, limits, mockClock);
    await tracker.commit({ tokensIn: 0, tokensOut: 0, costUsd: 5.5 });
    expect(() => tracker.assertAvailable(0)).toThrow(/daily dollar cap reached/);
  });

  it('rolls over at local midnight in the configured tz', async () => {
    const persistence = new InMemoryPersistence();
    const tracker = await BudgetTracker.load(persistence, limits, mockClock);
    await tracker.commit({ tokensIn: 99_000, tokensOut: 0, costUsd: 0 });
    expect(tracker.snapshot().tokens_input).toBe(99_000);

    // Advance the clock past local midnight PT (07:00 UTC the next day).
    mockNow = new Date('2026-05-05T08:00:00Z'); // 01:00 PT next day
    expect(() => tracker.assertAvailable(4096)).not.toThrow();
    expect(tracker.snapshot().day).toBe('2026-05-05');
    expect(tracker.snapshot().tokens_input).toBe(0);
  });

  it('treats different timezone as a fresh day', async () => {
    const persistence = new InMemoryPersistence();
    persistence.state = {
      day: '2026-05-04',
      tokens_input: 50_000,
      tokens_output: 0,
      dollars_estimated: 0,
      tz: 'UTC', // persisted under different tz
    };
    const tracker = await BudgetTracker.load(persistence, limits, mockClock);
    expect(tracker.snapshot().tokens_input).toBe(0);
    expect(tracker.snapshot().tz).toBe(PT);
  });
});

describe('formatDay()', () => {
  it('formats UTC times correctly in PT', () => {
    expect(formatDay(new Date('2026-05-04T19:00:00Z'), PT)).toBe('2026-05-04');
    // 06:30 UTC = 23:30 PT the previous day
    expect(formatDay(new Date('2026-05-04T06:30:00Z'), PT)).toBe('2026-05-03');
  });

  it('formats UTC times correctly in UTC', () => {
    expect(formatDay(new Date('2026-05-04T00:00:00Z'), 'UTC')).toBe('2026-05-04');
    expect(formatDay(new Date('2026-05-04T23:59:59Z'), 'UTC')).toBe('2026-05-04');
  });
});
