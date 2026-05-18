import type { VaultAdapter } from '../agent/types';

/**
 * One turn (user + assistant) in a conversation.
 */
export interface ConversationTurn {
  userMessage: string;
  assistantMessage: string;
  mode: 'chat' | 'vault-qa' | 'negotiate';
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** search_vault hits with score + snippet, for the ### Citations body block. */
  citations: ConversationCitation[];
  /**
   * Vault-relative paths the agent touched via any tool (read_note,
   * list_folder, search_vault, get_backlinks, get_graph_neighborhood).
   * Deduped. Drives the `notes_referenced` frontmatter field.
   */
  notesReferenced: string[];
  /** Names of tools the agent invoked. Drives the `tools_used` frontmatter field. */
  toolsUsed: string[];
  /** How many tool-use steps the agent took. */
  stepCount: number;
  durationMs: number;
}

export interface ConversationCitation {
  path: string;
  chunkIndex: number;
  score: number;
  snippet: string;
}

/**
 * Append-only handle to a single conversation file in the vault. Every
 * `append()` rewrites the file with the up-to-date frontmatter (turn
 * count, totals) + body. Files are tiny (a few KB per session) so the
 * rewrite cost is negligible and we avoid mid-file YAML edits.
 *
 * Path: `<basePath>/YYYY-MM-DD/<sessionId>.md` per spec §3.3.
 */
export class ConversationSession {
  private readonly turns: ConversationTurn[] = [];
  private readonly startedAt: Date;

  constructor(
    public readonly id: string,
    private readonly adapter: VaultAdapter,
    private readonly basePath: string,
    private readonly clock: () => Date,
    private readonly model: string,
  ) {
    this.startedAt = this.clock();
  }

  /**
   * Append a turn and persist. Idempotent at the file level — calling
   * twice with the same turns rewrites the file twice but produces
   * identical content.
   * @example await session.append({ userMessage: '...', assistantMessage: '...', ... });
   */
  async append(turn: ConversationTurn): Promise<void> {
    this.turns.push(turn);
    const path = this.filePath();
    const folder = path.substring(0, path.lastIndexOf('/'));
    await this.adapter.mkdir(folder);
    await this.adapter.write(path, this.render());
  }

  /** Vault-relative path of the session's markdown file. */
  filePath(): string {
    const day = formatDayUtc(this.startedAt);
    return `${this.basePath}/${day}/${this.id}.md`;
  }

  private render(): string {
    const totals = this.turns.reduce(
      (acc, t) => {
        acc.tokens += t.tokensIn + t.tokensOut;
        acc.cost += t.costUsd;
        return acc;
      },
      { tokens: 0, cost: 0 },
    );
    // Derive frontmatter aggregates from the structured per-turn fields
    // (toolsUsed, notesReferenced, citations) — not from inferred state.
    // Pre-v0.1.1 only `citations` existed and we inferred tools_used from
    // it, which left both lists empty whenever search_vault didn't fire.
    const tools = new Set<string>();
    const referencedNotes = new Set<string>();
    for (const turn of this.turns) {
      for (const t of turn.toolsUsed) {
        tools.add(t);
      }
      for (const path of turn.notesReferenced) {
        referencedNotes.add(path);
      }
      // citations also count as references (search_vault path).
      for (const cite of turn.citations) {
        referencedNotes.add(cite.path);
      }
    }

    const ended = this.turns.length > 0 ? this.clock() : this.startedAt;

    const frontmatter = [
      '---',
      'type: conversation',
      `session_id: ${this.id}`,
      `started: ${this.startedAt.toISOString()}`,
      `ended: ${ended.toISOString()}`,
      `model: ${this.model}`,
      `total_tokens: ${totals.tokens}`,
      `total_cost_usd: ${totals.cost.toFixed(4)}`,
      `turn_count: ${this.turns.length}`,
      `notes_referenced: [${[...referencedNotes].map((p) => `[[${p}]]`).join(', ')}]`,
      `tools_used: [${[...tools].join(', ')}]`,
      '---',
      '',
    ].join('\n');

    const body = this.turns
      .map((turn) => {
        const sections: string[] = [
          '## User',
          '',
          turn.userMessage,
          '',
          '## Sagittarius',
          '',
          turn.assistantMessage,
          '',
        ];
        if (turn.citations.length > 0) {
          sections.push('### Citations', '');
          for (const c of turn.citations) {
            sections.push(`- [[${c.path}]] (${c.score.toFixed(2)}): ${oneLine(c.snippet)}`);
          }
          sections.push('');
        }
        return sections.join('\n');
      })
      .join('\n');

    return frontmatter + body;
  }
}

/**
 * Logger that mints conversation sessions and persists them to the vault
 * under the configured base path (default `70-Memory/conversations`
 * per spec §3.1 + §3.3).
 *
 * @example
 *   const logger = new ConversationLogger(adapter, '70-Memory/conversations');
 *   const session = logger.startSession('claude-sonnet-4-6');
 *   await session.append({ ... });
 */
export class ConversationLogger {
  constructor(
    private readonly adapter: VaultAdapter,
    private readonly basePath: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly idGen: () => string = defaultIdGen,
  ) {}

  /** Start a new session. Returns a handle for appending turns. */
  startSession(model: string): ConversationSession {
    return new ConversationSession(this.idGen(), this.adapter, this.basePath, this.clock, model);
  }
}

function formatDayUtc(date: Date): string {
  // Conversation log filenames use UTC date so they're stable across
  // timezone changes; the BudgetTracker uses tz-local because budget
  // resets need to feel local. Different consumers, different needs.
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function defaultIdGen(): string {
  // Tiny session id — enough entropy to avoid collisions in a vault that
  // keeps thousands of conversations. Doesn't need to be a full UUID.
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `${ts}-${rand}`;
}
