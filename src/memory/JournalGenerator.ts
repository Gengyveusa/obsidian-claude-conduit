import type { Message, MessageCreateParams, TextBlock } from '@anthropic-ai/sdk/resources/messages';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

import type { BudgetTracker } from '../budget/BudgetTracker';

import { formatJournalSection, type JournalSection } from './journal';

/**
 * Phase 12 (v1.5.0) — agent-driven journal entry generation per
 * ADR-033 D4.
 *
 * Reads recent conversation history, prompts the model with a tight
 * "summarize for the journal" instruction, parses the response into
 * a `JournalSection`, and returns the formatted markdown block ready
 * for `append_to_note`.
 *
 * Architecture echoes `AnthropicDraftingEngine`: a separate class
 * with a small DI surface (messages API + budget tracker), no
 * coupling to ChatView or the chat tool-loop. The ADR D4 originally
 * called for a `mode: 'journal'` on `ConduitAgent.chat()`; isolating
 * to a separate class better matches the spirit (testable, distinct,
 * doesn't pollute the chat path) without touching ChatView's mode
 * type or ToolRegistry.
 */

/** Subset of `Anthropic.messages` the generator calls — mockable. */
export interface JournalMessagesAPI {
  create(params: MessageCreateParams): Promise<Message>;
}

const MAX_OUTPUT_TOKENS = 1500;

/** Per-million-token pricing — mirrors ConduitAgent. */
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-opus-4-7': { in: 15, out: 75 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
};

export interface JournalGeneratorDeps {
  messages: JournalMessagesAPI;
  budget: BudgetTracker;
  /** Live accessor — read on each call so model swaps take effect. */
  settings: () => { journalModel: string; timezone: string };
  clock?: () => Date;
  logger?: { warn: (msg: string) => void };
}

export interface JournalGenerationResult {
  /** The formatted H2 markdown block ready to append to today's journal. */
  markdown: string;
  /** The structured section the model produced (debug + tests). */
  section: JournalSection;
  /** Title of the entry (extracted or operator-provided). */
  title: string;
  /** Wall-clock timestamp the entry was generated (in operator's tz when formatted). */
  generatedAt: Date;
}

/**
 * Build a journal entry from conversation history. Caller is
 * responsible for taking the result.markdown and proposing the
 * append (through the diff card per ADR-016 D2).
 */
export class AnthropicJournalGenerator {
  private readonly deps: JournalGeneratorDeps;
  private readonly clock: () => Date;

  constructor(deps: JournalGeneratorDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? ((): Date => new Date());
    // Logger reserved for future warn-paths (e.g. partial parse failures);
    // intentionally not stored as a class field until then.
    void deps.logger;
  }

  /**
   * Generate one journal entry summarizing the supplied history.
   * History is the conversation turns since the last journal entry
   * (caller decides how to slice).
   *
   * @param title Short label for the H2 header. Operator-supplied or
   *   computed from the last user message. Empty string falls back
   *   to "Session" + timestamp.
   */
  async generate(opts: {
    history: ReadonlyArray<MessageParam>;
    title: string;
  }): Promise<JournalGenerationResult> {
    if (opts.history.length === 0) {
      throw new Error(
        'JournalGenerator: history is empty — no conversation to summarize.',
      );
    }
    const settings = this.deps.settings();
    this.deps.budget.assertAvailable(MAX_OUTPUT_TOKENS);

    const userMessage = buildUserMessage(opts.history);
    const response = await this.deps.messages.create({
      model: settings.journalModel,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content
      .filter((block): block is TextBlock => block.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text.length === 0) {
      throw new Error('JournalGenerator: model returned no text content.');
    }

    const section = parseJournalResponse(text);

    const pricing = PRICING[settings.journalModel] ?? PRICING['claude-sonnet-4-6'];
    const tokensIn = response.usage.input_tokens;
    const tokensOut = response.usage.output_tokens;
    const costUsd = (tokensIn / 1_000_000) * pricing.in + (tokensOut / 1_000_000) * pricing.out;
    await this.deps.budget.commit({ tokensIn, tokensOut, costUsd });

    const generatedAt = this.clock();
    const titleResolved = opts.title.trim().length === 0 ? 'Session' : opts.title.trim();
    const markdown = formatJournalSection(generatedAt, titleResolved, section, settings.timezone);

    return { markdown, section, title: titleResolved, generatedAt };
  }
}

/**
 * Parse the model's response into a `JournalSection` per ADR-033 D3.
 * Tolerant: missing bullets degrade to '(not specified)' rather than
 * throwing, since the operator can edit the proposed entry in the
 * diff card.
 *
 * Exported for tests.
 */
export function parseJournalResponse(text: string): JournalSection {
  return {
    workedOn: extractBullet(text, 'Worked on'),
    decided: extractBullet(text, 'Decided'),
    learnedAboutOperator: extractBullet(text, 'Learned about operator'),
    openThreads: extractBullet(text, 'Open threads'),
  };
}

function extractBullet(text: string, label: string): string {
  // Match a line like "- **Worked on:** ..." or "* **Worked on:** ..."
  // The closing emphasis can land BEFORE the colon (`**Worked on**:`)
  // or AFTER the colon (`**Worked on:** value`); both are valid
  // markdown. Pattern accepts any combination of `*` / `_` around
  // the label and the colon, then captures the value and strips
  // leading/trailing emphasis from it.
  const pattern = new RegExp(
    `^\\s*[-*]\\s*[*_]{0,2}${escapeRegex(label)}[*_]{0,2}\\s*:\\s*[*_]{0,2}\\s*(.+?)\\s*$`,
    'mi',
  );
  const match = pattern.exec(text);
  if (match === null) {
    return '(not specified)';
  }
  // Strip a trailing `**` / `__` that the model sometimes places
  // BEFORE the colon-and-value pattern's emphasis chars.
  return match[1].trim().replace(/[*_]{2,}$/, '').trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SYSTEM_PROMPT = `You are summarizing the operator's last working session for a durable memory journal that future sessions of you will read back. Output ONLY the journal entry as a markdown bullet list with EXACTLY four bullets in this format:

- **Worked on:** <one-line summary of what the operator was doing this session>
- **Decided:** <one-line summary of any decisions made; "none" if none>
- **Learned about operator:** <one-line summary of facts about the operator's preferences, patterns, state, or context that future-you should know; "none" if none>
- **Open threads:** <one-line summary of TODOs / unfinished work to pick up; "none" if none>

Rules:
- No preamble, no commentary, no other content. The bullets are the entire response.
- Each bullet stays on one line. ~80 chars per bullet ideal.
- "Learned about operator" must be FACTUAL ("operator prefers tight planning ADRs", "operator works after midnight"), NOT FLATTERING ("operator is brilliant"). Sycophancy is forbidden.
- Be specific and useful. Vague entries ("operator did some work") are worse than "none".
`;

function buildUserMessage(history: ReadonlyArray<MessageParam>): string {
  const lines: string[] = ['# Session transcript', ''];
  for (const turn of history) {
    const role = turn.role === 'user' ? 'Operator' : 'You';
    const content = typeof turn.content === 'string' ? turn.content : extractText(turn.content);
    lines.push(`## ${role}`);
    lines.push('');
    lines.push(content);
    lines.push('');
  }
  lines.push('# Task');
  lines.push('');
  lines.push('Summarize the session above into the four-bullet journal format.');
  return lines.join('\n');
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) {
    return String(content);
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const b = block as { type?: string; text?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      }
    }
  }
  return parts.join('\n');
}
