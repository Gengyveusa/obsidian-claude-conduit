import { APIError } from '@anthropic-ai/sdk';
import type {
  Message,
  MessageCreateParams,
  MessageParam,
  TextBlock,
  TextBlockParam,
  ToolUseBlock,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages';

import type { ConversationCitation, ConversationLogger } from '../log/ConversationLogger';
import type { BudgetTracker } from '../budget/BudgetTracker';
import type { RetrievalLayer } from '../retrieval/RetrievalLayer';
import type { WriteToolContext } from '../writes/WriteToolContext';
import type { ToolRegistry } from './ToolRegistry';

const MAX_STEPS = 20;
const MAX_OUTPUT_TOKENS = 4096;

/**
 * Per-million-token pricing in USD as of cutoff. Sonnet 4.6: $3 in, $15 out.
 * Opus 4.7: $15 in, $75 out. Haiku 4.5: $1 in, $5 out.
 */
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-opus-4-7': { in: 15, out: 75 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
};

/**
 * Subset of `Anthropic.messages` we actually call. Lets tests inject a
 * stub without instantiating the real SDK or hitting the network.
 */
export interface MessagesAPI {
  create(params: MessageCreateParams): Promise<Message>;
}

/**
 * Static parts of the system prompt — loaded from the vault by the caller
 * and cached at the model boundary (cache_control: ephemeral) per spec
 * §6.2 + killer prompt §4.
 */
export interface SystemPromptParts {
  /** Contents of THAD_MAN.md — the constitution. */
  constitution: string;
  /** Contents of concierge.md — the Hangar voice. */
  hangarVoice: string;
}

/**
 * Phase 9 (v1.3.0) — per-turn memory cascade per ADR-029 D6.
 *
 * Memory is re-read from disk on every chat turn (so operator edits
 * to CLAUDE.md take effect immediately) but is NOT plumbed through
 * `SystemPromptParts` — those are the cached, slow-changing static
 * blocks. Memory is its own seam: the provider is async, called
 * once per `chat()` invocation, and the result is passed to
 * `buildSystemPrompt` as a parameter.
 *
 * Implementations return the pre-formatted prompt text (the labeled
 * sections per D3) or `null` when nothing applies. Errors during
 * resolution should be caught and logged by the provider — the
 * agent treats a thrown provider as "no memory" rather than failing
 * the turn.
 */
export interface MemoryProvider {
  /** Return the memory block text for this turn, or `null` to skip. */
  collect(): Promise<string | null>;
}

export interface ConduitAgentSettings {
  defaultModel: string;
  fallbackModel: string;
  retrievalK: number;
}

export interface ConduitAgentDeps {
  messages: MessagesAPI;
  tools: ToolRegistry;
  /** Optional: omit if the plugin's retrieval layer isn't ready yet. */
  retrieval?: RetrievalLayer;
  budget: BudgetTracker;
  logger: ConversationLogger;
  systemPromptParts: SystemPromptParts;
  /**
   * Phase 9 (v1.3.0) — CLAUDE.md cascade per ADR-029. Optional: if
   * omitted, no memory block is injected. Called once per `chat()`
   * invocation; thrown errors degrade to "no memory" with a warn-
   * level log rather than failing the turn.
   */
  memoryProvider?: MemoryProvider;
  /**
   * Per-turn transaction lifecycle for Phase 4 write tools (ADR-016 D3).
   * `chat()` calls `ctx.begin()` before the tool-use loop and `ctx.end()`
   * (or `ctx.abandon()` on failure) after — write tools call `ctx.record()`
   * during their handlers. Required even when no write tools are
   * registered; an empty transaction is a no-op.
   */
  ctx: WriteToolContext;
}

export interface TurnResult {
  finalText: string;
  citations: ConversationCitation[];
  steps: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
}

/**
 * Single class that orchestrates one chat turn — builds the system
 * prompt, runs the tool-use loop, accounts tokens, falls back on
 * overload, logs to the vault.
 *
 * @example
 *   const agent = new ConduitAgent(deps, settings);
 *   const result = await agent.chat('Where does Phase 1 stand?', [], 'vault-qa');
 *   console.log(result.finalText);
 */
export class ConduitAgent {
  constructor(
    private readonly deps: ConduitAgentDeps,
    private readonly settings: ConduitAgentSettings,
  ) {}

  /**
   * Run one chat turn. Returns the final assistant text plus accounting.
   * @example const { finalText } = await agent.chat('hi', [], 'chat');
   */
  async chat(
    userMessage: string,
    history: MessageParam[],
    mode: 'chat' | 'vault-qa',
    onToken?: (text: string) => void,
  ): Promise<TurnResult> {
    const startedAt = Date.now();

    // 0. Pre-flight budget check.
    this.deps.budget.assertAvailable(MAX_OUTPUT_TOKENS);

    // 0.5. Open a transaction for any write tools that run in this turn.
    // Always opened, even if no writes happen; empty transactions are
    // no-ops (`builder.commit()` returns null without persisting). The
    // `finally` block at the bottom of this method abandons the
    // transaction on any throw, so the write log can never get stuck open.
    this.deps.ctx.begin();

    try {
      // 1. vault-qa: one pre-retrieval pass to seed the system prompt.
      const retrieved = await this.preRetrieve(userMessage, mode);

      // 1b. Phase 9 (v1.3.0) — collect memory cascade per ADR-029.
      // Per-turn fetch per D6; provider errors degrade to "no memory"
      // rather than failing the turn.
      let memory: string | null = null;
      if (this.deps.memoryProvider !== undefined) {
        try {
          memory = await this.deps.memoryProvider.collect();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[sagittarius] memory provider failed: ${msg}`);
        }
      }

      // 2. Build the system prompt with cache breakpoints.
      const system = this.buildSystemPrompt(retrieved, mode, memory);

      // 3. Compose the message stack.
      const messages: MessageParam[] = [
        ...history,
        { role: 'user', content: userMessage },
      ];

      let stepCount = 0;
      let finalText = '';
      const citations: ConversationCitation[] = retrieved.map((r) => ({
        path: r.path,
        chunkIndex: r.chunkIndex,
        score: r.score,
        snippet: r.snippet,
      }));
      const toolsUsed = new Set<string>();
      const notesReferenced = new Set<string>();
      let tokensIn = 0;
      let tokensOut = 0;

      // 4. tool-use ↔ model loop.
      while (stepCount < MAX_STEPS) {
        stepCount++;

        const response = await this.callModel(system, messages);
        tokensIn += response.usage.input_tokens;
        tokensOut += response.usage.output_tokens;
        messages.push({ role: 'assistant', content: response.content });

        if (response.stop_reason === 'end_turn') {
          finalText = extractText(response.content);
          if (onToken && finalText) {
            onToken(finalText);
          }
          break;
        }

        if (response.stop_reason === 'tool_use') {
          const toolUses = response.content.filter(isToolUseBlock);
          const toolResults = await Promise.all(
            toolUses.map((tu) =>
              this.runTool(tu, citations, toolsUsed, notesReferenced),
            ),
          );
          messages.push({ role: 'user', content: toolResults });
          continue;
        }

        // Any other stop_reason (max_tokens, pause_turn) → bail with what we have.
        finalText = extractText(response.content);
        break;
      }

      if (stepCount >= MAX_STEPS && !finalText) {
        throw new Error(
          `ConduitAgent exceeded ${MAX_STEPS} tool-use steps. ` +
            `Likely cause: recursion in tool calls. Check the conversation log.`,
        );
      }

      // Close the transaction. Commits whatever write ops the loop recorded,
      // or returns null + persists nothing if it was a read-only turn.
      await this.deps.ctx.end();

      // 5. Cost accounting + budget commit.
      const costUsd = estimateCost(tokensIn, tokensOut, this.settings.defaultModel);
      await this.deps.budget.commit({ tokensIn, tokensOut, costUsd });

      const durationMs = Date.now() - startedAt;

      // 6. Log the turn to the vault. The session is per-chat-turn-batch in
      // v0.1; the caller (ChatView) holds onto it across turns. For now we
      // mint a fresh session per call — refactor when ChatView lands.
      // Pre-retrieval (vault-qa mode) seeds search_vault citations directly,
      // so add their paths to notesReferenced too.
      for (const c of citations) {
        notesReferenced.add(c.path);
      }

      const session = this.deps.logger.startSession(this.settings.defaultModel);
      await session.append({
        userMessage,
        assistantMessage: finalText,
        mode,
        model: this.settings.defaultModel,
        tokensIn,
        tokensOut,
        costUsd,
        citations,
        notesReferenced: [...notesReferenced],
        toolsUsed: [...toolsUsed],
        stepCount,
        durationMs,
      });

      return {
        finalText,
        citations,
        steps: stepCount,
        tokensIn,
        tokensOut,
        costUsd,
        durationMs,
      };
    } finally {
      // Defensive cleanup. abandon() is idempotent (no-op when ctx.end()
      // already closed the transaction) and safe to call on throw paths.
      this.deps.ctx.abandon();
    }
  }

  private async preRetrieve(
    query: string,
    mode: 'chat' | 'vault-qa',
  ): Promise<ConversationCitation[]> {
    if (mode !== 'vault-qa' || !this.deps.retrieval) {
      return [];
    }
    const hits = await this.deps.retrieval.queryUnified({
      query,
      limit: this.settings.retrievalK,
      sourceDb: 'both',
    });
    return hits.map((h) => ({
      path: h.path,
      chunkIndex: h.chunk,
      score: h.score,
      snippet: h.text,
    }));
  }

  /** Single SDK call; falls back to the secondary model on overload (503/529). */
  private async callModel(
    system: TextBlockParam[],
    messages: MessageParam[],
  ): Promise<Message> {
    const baseParams = {
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      tools: this.deps.tools.schemas(),
      messages,
      stream: false as const,
    };
    try {
      return await this.deps.messages.create({ ...baseParams, model: this.settings.defaultModel });
    } catch (err) {
      if (isOverloaded(err)) {
        return this.deps.messages.create({ ...baseParams, model: this.settings.fallbackModel });
      }
      throw err;
    }
  }

  private async runTool(
    tu: ToolUseBlock,
    citations: ConversationCitation[],
    toolsUsed: Set<string>,
    notesReferenced: Set<string>,
  ): Promise<ToolResultBlockParam> {
    // Always record the tool name, even if the call fails — the agent
    // tried to use it, which is the signal we want in the conversation log.
    toolsUsed.add(tu.name);
    try {
      const result = await this.deps.tools.execute(tu.name, tu.input);
      // Track citations + note references from tool calls.
      if (tu.name === 'search_vault' && Array.isArray(result)) {
        for (const r of result as Array<{
          path: string;
          chunk: number;
          score: number;
          text: string;
        }>) {
          citations.push({
            path: r.path,
            chunkIndex: r.chunk,
            score: r.score,
            snippet: r.text,
          });
          notesReferenced.add(r.path);
        }
      }
      // Extract note paths from non-search-vault tools so they show up
      // in the conversation log's `notes_referenced` frontmatter.
      for (const path of extractNotePaths(tu.name, tu.input, result)) {
        notesReferenced.add(path);
      }
      return {
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        type: 'tool_result',
        tool_use_id: tu.id,
        is_error: true,
        content: `Error: ${msg}`,
      };
    }
  }

  /**
   * Build a system prompt as an array of text blocks with cache control
   * on the large static parts (constitution, tools help). The retrieved
   * chunks block changes per turn so it's not cached.
   */
  private buildSystemPrompt(
    retrieved: ConversationCitation[],
    mode: 'chat' | 'vault-qa',
    memory: string | null,
  ): TextBlockParam[] {
    const modeAddendum =
      mode === 'vault-qa'
        ? 'Mode: VAULT QA. Every answer must cite at least one note from search_vault results.'
        : "Mode: CHAT. Cite when you use tools; don't over-cite for general knowledge.";

    const toolsHelp = this.toolsHelpText();

    const blocks: TextBlockParam[] = [
      {
        type: 'text',
        text: this.deps.systemPromptParts.constitution,
        cache_control: { type: 'ephemeral' },
      },
    ];
    if (memory !== null && memory.length > 0) {
      // Own cache breakpoint per ADR-029 D5: operator edits to
      // CLAUDE.md invalidate this block without dropping the
      // constitution cache above.
      blocks.push({ type: 'text', text: memory, cache_control: { type: 'ephemeral' } });
    }
    blocks.push(
      { type: 'text', text: this.deps.systemPromptParts.hangarVoice },
      { type: 'text', text: toolsHelp, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: modeAddendum },
    );

    if (retrieved.length > 0) {
      const retrievedBlock =
        '## Pre-retrieved context\n\n' +
        retrieved
          .map((r) => `### [[${r.path}]] (score ${r.score.toFixed(2)})\n${r.snippet}`)
          .join('\n\n');
      blocks.push({ type: 'text', text: retrievedBlock });
    }

    return blocks;
  }

  private toolsHelpText(): string {
    const lines = ['# Tools', ''];
    for (const schema of this.deps.tools.schemas()) {
      lines.push(`- \`${schema.name}\` — ${schema.description}`);
    }
    return lines.join('\n');
  }
}

function isToolUseBlock(b: Message['content'][number]): b is ToolUseBlock {
  return b.type === 'tool_use';
}

function extractText(content: Message['content']): string {
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * Extract vault-relative note paths from a tool call's input + result, so
 * the conversation log can record what the agent actually touched. Knows
 * the v0.1 tool surface; unknown tools contribute nothing.
 *
 * Why duplicate the tool surface here rather than asking each tool to
 * declare its own extractor: the v0.1 surface is fixed and small (5
 * tools), and a per-tool extractor protocol is bigger surface area than
 * the deduplication saves. Revisit when the tool count crosses ~10.
 */
function extractNotePaths(
  toolName: string,
  input: unknown,
  result: unknown,
): string[] {
  const paths: string[] = [];
  const inputObj = isRecord(input) ? input : null;
  const resultObj = isRecord(result) ? result : null;

  switch (toolName) {
    case 'read_note': {
      // Input: { path }. Result: { path, ... } | null.
      if (resultObj && typeof resultObj['path'] === 'string') {
        paths.push(resultObj['path']);
      } else if (inputObj && typeof inputObj['path'] === 'string') {
        paths.push(inputObj['path']);
      }
      break;
    }
    case 'list_folder': {
      // Result: { folder, notes: [{ path, ... }, ...], subfolders }.
      if (resultObj && Array.isArray(resultObj['notes'])) {
        for (const n of resultObj['notes']) {
          if (isRecord(n) && typeof n['path'] === 'string') {
            paths.push(n['path']);
          }
        }
      }
      break;
    }
    case 'get_backlinks': {
      // Result: { target, inbound: [{ path, ... }, ...], total }.
      if (resultObj) {
        if (typeof resultObj['target'] === 'string') {
          paths.push(resultObj['target']);
        }
        if (Array.isArray(resultObj['inbound'])) {
          for (const i of resultObj['inbound']) {
            if (isRecord(i) && typeof i['path'] === 'string') {
              paths.push(i['path']);
            }
          }
        }
      }
      break;
    }
    case 'get_graph_neighborhood': {
      // Result: { origin, nodes: [{ path, ... }, ...], edges }.
      if (resultObj) {
        if (typeof resultObj['origin'] === 'string') {
          paths.push(resultObj['origin']);
        }
        if (Array.isArray(resultObj['nodes'])) {
          for (const n of resultObj['nodes']) {
            if (isRecord(n) && typeof n['path'] === 'string') {
              paths.push(n['path']);
            }
          }
        }
      }
      break;
    }
    // search_vault is handled separately by the citations capture path.
    default:
      break;
  }
  return paths;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True if the error indicates upstream overload (HTTP 503 or 529). */
export function isOverloaded(err: unknown): boolean {
  if (err instanceof APIError) {
    return err.status === 503 || err.status === 529;
  }
  return false;
}

/** Estimate USD cost for a turn, in dollars. Falls back to Sonnet pricing for unknown models. */
export function estimateCost(tokensIn: number, tokensOut: number, model: string): number {
  const p = PRICING[model] ?? PRICING['claude-sonnet-4-6'];
  return (tokensIn / 1_000_000) * p.in + (tokensOut / 1_000_000) * p.out;
}

export { MAX_STEPS, MAX_OUTPUT_TOKENS };
