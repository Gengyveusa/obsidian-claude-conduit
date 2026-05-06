/**
 * Per-day token + dollar accounting with timezone-aware rollover.
 *
 * Persists state to a host-managed key/value store (typically the
 * plugin's `data.json` for the budget portion, or a separate
 * `budget.json`). Production wires `BudgetPersistence` to Obsidian's
 * data adapter; tests inject an in-memory implementation.
 */

const MS_PER_HOUR = 3_600_000;

/** Persisted budget state per spec §3.4. */
export interface BudgetState {
  /** YYYY-MM-DD in the configured timezone. */
  day: string;
  tokens_input: number;
  tokens_output: number;
  dollars_estimated: number;
  /** IANA timezone name (e.g. 'America/Los_Angeles'). */
  tz: string;
}

export interface BudgetLimits {
  maxTokensPerDay: number;
  maxDollarsPerDay: number;
  /** IANA timezone name. */
  tz: string;
}

export interface BudgetPersistence {
  load(): Promise<BudgetState | null>;
  save(state: BudgetState): Promise<void>;
}

export interface BudgetUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/**
 * Daily budget tracker. Asserts capacity before each turn, commits actual
 * usage after each turn, rolls over at local midnight in the configured
 * timezone.
 *
 * @example
 *   const tracker = await BudgetTracker.load(persistence, limits);
 *   tracker.assertAvailable(4096);  // throws if today's spend would exceed cap
 *   await tracker.commit({ tokensIn: 1234, tokensOut: 567, costUsd: 0.012 });
 */
export class BudgetTracker {
  private state: BudgetState;

  private constructor(
    private readonly persistence: BudgetPersistence,
    private readonly limits: BudgetLimits,
    private readonly clock: () => Date,
    initial: BudgetState,
  ) {
    this.state = initial;
  }

  /**
   * Load the persisted budget state, or initialize a fresh one for today.
   * @example const t = await BudgetTracker.load(persistence, limits);
   */
  static async load(
    persistence: BudgetPersistence,
    limits: BudgetLimits,
    clock: () => Date = () => new Date(),
  ): Promise<BudgetTracker> {
    const today = formatDay(clock(), limits.tz);
    const persisted = await persistence.load();

    let initial: BudgetState;
    if (persisted && persisted.day === today && persisted.tz === limits.tz) {
      initial = persisted;
    } else {
      // New day or tz change → fresh state.
      initial = {
        day: today,
        tokens_input: 0,
        tokens_output: 0,
        dollars_estimated: 0,
        tz: limits.tz,
      };
      await persistence.save(initial);
    }
    return new BudgetTracker(persistence, limits, clock, initial);
  }

  /**
   * Throw if today's accumulated usage plus a reserved output budget would
   * exceed the daily token cap. Reserve 4096 (or whatever max_tokens you'll
   * pass to the model) to avoid mid-call cap busts.
   *
   * Also throws if the dollar cap is already exceeded — output cost is
   * harder to predict so we don't pre-reserve dollars.
   *
   * @example tracker.assertAvailable(4096);
   */
  assertAvailable(reservedOutputTokens: number): void {
    this.rolloverIfNewDay();
    const projectedTokens =
      this.state.tokens_input + this.state.tokens_output + reservedOutputTokens;
    if (projectedTokens > this.limits.maxTokensPerDay) {
      throw new Error(
        `BudgetTracker: daily token cap reached. ` +
          `Used ${this.state.tokens_input + this.state.tokens_output} + reserve ${reservedOutputTokens} ` +
          `> max ${this.limits.maxTokensPerDay}. Wait until midnight in ${this.limits.tz} or raise the cap in Settings.`,
      );
    }
    if (this.state.dollars_estimated >= this.limits.maxDollarsPerDay) {
      throw new Error(
        `BudgetTracker: daily dollar cap reached. ` +
          `Spent $${this.state.dollars_estimated.toFixed(4)} >= max $${this.limits.maxDollarsPerDay}. ` +
          `Wait until midnight in ${this.limits.tz} or raise the cap in Settings.`,
      );
    }
  }

  /**
   * Add a turn's actual usage to the running total and persist.
   * @example await tracker.commit({ tokensIn: 1234, tokensOut: 567, costUsd: 0.012 });
   */
  async commit(usage: BudgetUsage): Promise<void> {
    this.rolloverIfNewDay();
    this.state.tokens_input += usage.tokensIn;
    this.state.tokens_output += usage.tokensOut;
    this.state.dollars_estimated += usage.costUsd;
    await this.persistence.save(this.state);
  }

  /** Returns a defensive copy of the current state. */
  snapshot(): BudgetState {
    return { ...this.state };
  }

  /** If the configured tz says it's a new day since `state.day`, zero everything. */
  private rolloverIfNewDay(): void {
    const today = formatDay(this.clock(), this.limits.tz);
    if (today !== this.state.day) {
      this.state = {
        day: today,
        tokens_input: 0,
        tokens_output: 0,
        dollars_estimated: 0,
        tz: this.limits.tz,
      };
      // Persistence happens on the next commit() — no need for an extra
      // write just to record a zeroed state.
    }
  }
}

/**
 * Format a Date as YYYY-MM-DD in the given IANA timezone.
 *
 * Uses `Intl.DateTimeFormat` so DST + leap-second oddities Just Work
 * without us reimplementing tz math.
 *
 * @example formatDay(new Date('2026-05-04T08:00:00Z'), 'America/Los_Angeles')  // '2026-05-04'
 */
export function formatDay(date: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  // 'en-CA' formats as YYYY-MM-DD natively — no parts juggling.
  return fmt.format(date);
}

/** Intentionally exported for tests that need to advance the clock. */
export { MS_PER_HOUR };
