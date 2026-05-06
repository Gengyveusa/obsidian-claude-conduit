---
title: "Sagittarius — ConduitAgent class sketch"
type: project
status: draft
created: 2026-05-04
updated: 2026-05-04
tags: [sagittarius, plugin, conduit-agent, typescript, sketch, project, thad-man]
related:
  - "[[18-Obsidian-Claude-Plugin/02_SPEC]]"
  - "[[18-Obsidian-Claude-Plugin/03_PACKAGE_JSON]]"
last_reviewed: 2026-05-04
---

# Sagittarius — ConduitAgent class sketch

> Per kickoff §1.4, a 10-line sketch was promised. This file delivers an expanded version with type signatures and the agent loop's first iteration. **Not production code** — design intent. The actual implementation lives in `gengyveusa/obsidian-claude-conduit/src/agent/ConduitAgent.ts` once Phase 2 scaffolds the repo.

## Goal

The ConduitAgent is the **single class** that orchestrates a chat turn. Side panel and modal both call into it. It owns:
- The Anthropic client
- The tool registry
- The system-prompt builder
- The agent loop (tool-use ↔ model)
- Token + cost accounting
- Conversation logging

## TypeScript sketch

```typescript
// src/agent/ConduitAgent.ts
import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageParam,
  TextBlock,
  ToolUseBlock,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";

import type { ToolRegistry } from "./ToolRegistry";
import type { RetrievalLayer } from "../retrieval/RetrievalLayer";
import type { BudgetTracker } from "../budget/BudgetTracker";
import type { ConversationLogger } from "../log/ConversationLogger";
import type { SagittariusSettings } from "../settings/types";

const MAX_STEPS = 20;            // hard cap per killer prompt §4
const MAX_OUTPUT_TOKENS = 4096;  // reserve for model output

export interface TurnResult {
  finalText: string;
  citations: Citation[];
  steps: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
}

export interface Citation {
  path: string;       // vault-relative
  chunkIndex: number;
  score: number;
  snippet: string;
}

export class ConduitAgent {
  private client: Anthropic;

  constructor(
    private readonly settings: SagittariusSettings,
    private readonly tools: ToolRegistry,
    private readonly retrieval: RetrievalLayer,
    private readonly budget: BudgetTracker,
    private readonly logger: ConversationLogger,
    private readonly vaultRoot: string,
  ) {
    this.client = new Anthropic({
      apiKey: settings.apiKey,
      dangerouslyAllowBrowser: true,  // required inside Obsidian's renderer process
    });
  }

  async chat(
    userMessage: string,
    history: MessageParam[],
    mode: "chat" | "vault-qa",
    onToken?: (text: string) => void,
  ): Promise<TurnResult> {
    const startedAt = performance.now();

    // 0. Pre-flight budget check
    this.budget.assertAvailable(MAX_OUTPUT_TOKENS);

    // 1. Pre-retrieval pass for vault-qa mode (single search before turn)
    const retrieved = mode === "vault-qa"
      ? await this.retrieval.queryUnified({
          query: userMessage,
          limit: this.settings.retrievalK,
          source_db: "both",
        })
      : [];

    // 2. Build system prompt with cache breakpoints
    const system = await this.buildSystemPrompt(retrieved, mode);

    // 3. Compose messages
    const messages: MessageParam[] = [...history, { role: "user", content: userMessage }];

    let stepCount = 0;
    let finalText = "";
    const citations: Citation[] = retrieved.map(r => ({
      path: r.path,
      chunkIndex: r.chunk,
      score: r.score,
      snippet: r.text,
    }));
    let tokensIn = 0;
    let tokensOut = 0;

    // 4. Agent loop — tool-use ↔ model
    while (stepCount < MAX_STEPS) {
      stepCount++;

      const response: Message = await this.callModel(system, messages);

      tokensIn += response.usage.input_tokens;
      tokensOut += response.usage.output_tokens;

      // Append assistant turn
      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "end_turn") {
        // Extract text blocks for the final answer
        finalText = response.content
          .filter((b): b is TextBlock => b.type === "text")
          .map(b => b.text)
          .join("");
        if (onToken) onToken(finalText);
        break;
      }

      if (response.stop_reason === "tool_use") {
        // Execute every tool_use block in parallel; collect results
        const toolUses = response.content.filter(
          (b): b is ToolUseBlock => b.type === "tool_use",
        );
        const toolResults: ToolResultBlockParam[] = await Promise.all(
          toolUses.map(async (tu) => {
            try {
              const result = await this.tools.execute(tu.name, tu.input);
              // Track citations from search_vault calls
              if (tu.name === "search_vault" && Array.isArray(result)) {
                for (const r of result) {
                  citations.push({
                    path: r.path,
                    chunkIndex: r.chunk,
                    score: r.score,
                    snippet: r.text,
                  });
                }
              }
              return {
                type: "tool_result" as const,
                tool_use_id: tu.id,
                content: JSON.stringify(result),
              };
            } catch (err) {
              return {
                type: "tool_result" as const,
                tool_use_id: tu.id,
                is_error: true,
                content: `Error: ${err instanceof Error ? err.message : String(err)}`,
              };
            }
          }),
        );

        messages.push({ role: "user", content: toolResults });
        continue;
      }

      // Any other stop_reason (max_tokens, pause_turn) → bail with what we have
      finalText = response.content
        .filter((b): b is TextBlock => b.type === "text")
        .map(b => b.text)
        .join("");
      break;
    }

    if (stepCount >= MAX_STEPS) {
      throw new Error(
        `ConduitAgent exceeded ${MAX_STEPS} tool-use steps. ` +
        `Likely cause: recursion in tool calls. Check the conversation log.`,
      );
    }

    // 5. Cost accounting
    const costUsd = this.estimateCost(tokensIn, tokensOut, this.settings.defaultModel);
    this.budget.commit({ tokensIn, tokensOut, costUsd });

    const durationMs = performance.now() - startedAt;

    // 6. Log to vault
    await this.logger.append({
      userMessage,
      assistantMessage: finalText,
      mode,
      model: this.settings.defaultModel,
      tokensIn,
      tokensOut,
      costUsd,
      citations,
      stepCount,
      durationMs,
    });

    return { finalText, citations, steps: stepCount, tokensIn, tokensOut, costUsd, durationMs };
  }

  /**
   * Single SDK call with model fallback.
   * Sonnet is default; Opus on overload retry.
   */
  private async callModel(
    system: Anthropic.MessageCreateParams["system"],
    messages: MessageParam[],
  ): Promise<Message> {
    try {
      return await this.client.messages.create({
        model: this.settings.defaultModel,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        tools: this.tools.schemas(),
        messages,
      });
    } catch (err) {
      // 503/overloaded → retry once with fallback model
      if (this.isOverloaded(err)) {
        return await this.client.messages.create({
          model: this.settings.fallbackModel,
          max_tokens: MAX_OUTPUT_TOKENS,
          system,
          tools: this.tools.schemas(),
          messages,
        });
      }
      throw err;
    }
  }

  /**
   * System prompt with cache breakpoints per killer prompt §4.
   * Constitution + Hangar voice + tools list = cached (changes rarely).
   * Retrieved chunks + mode addendum = uncached (per-turn).
   */
  private async buildSystemPrompt(
    retrieved: Citation[],
    mode: "chat" | "vault-qa",
  ): Promise<Anthropic.MessageCreateParams["system"]> {
    // Cached blocks (high reuse across turns)
    const constitution = await this.readVaultFile("THAD_MAN.md");
    const hangarVoice = await this.readVaultFile("21-Agents/concierge.md");
    const toolsHelp = this.tools.helpText();

    // Per-turn block (varies)
    const modeAddendum = mode === "vault-qa"
      ? "Mode: VAULT QA. Every answer must cite at least one note from search_vault results."
      : "Mode: CHAT. Cite when you use tools; don't over-cite for general knowledge.";

    const retrievedBlock = retrieved.length
      ? "## Pre-retrieved context\n\n" + retrieved.map(r =>
          `### [[${r.path}]] (score ${r.score.toFixed(2)})\n${r.snippet}`,
        ).join("\n\n")
      : "";

    return [
      { type: "text", text: constitution, cache_control: { type: "ephemeral" } },
      { type: "text", text: hangarVoice },
      { type: "text", text: toolsHelp, cache_control: { type: "ephemeral" } },
      { type: "text", text: modeAddendum },
      ...(retrievedBlock ? [{ type: "text" as const, text: retrievedBlock }] : []),
    ];
  }

  private async readVaultFile(relPath: string): Promise<string> {
    // Reads through Obsidian's vault adapter — not raw fs.
    // Adapter handles cross-platform paths and respects vault scoping.
    // (Implementation injected via constructor in real impl.)
    throw new Error("Implement via Obsidian vault adapter");
  }

  private estimateCost(tokensIn: number, tokensOut: number, model: string): number {
    // Pricing as of cutoff (cents per 1M tokens):
    // Sonnet 4.6: $3 in, $15 out. Opus 4.7: $15 in, $75 out. Haiku 4.5: $1 in, $5 out.
    const pricing: Record<string, { in: number; out: number }> = {
      "claude-sonnet-4-6":           { in: 3,  out: 15 },
      "claude-opus-4-7":             { in: 15, out: 75 },
      "claude-haiku-4-5-20251001":   { in: 1,  out: 5  },
    };
    const p = pricing[model] ?? pricing["claude-sonnet-4-6"];
    return (tokensIn / 1_000_000) * p.in + (tokensOut / 1_000_000) * p.out;
  }

  private isOverloaded(err: unknown): boolean {
    if (err instanceof Anthropic.APIError) {
      return err.status === 503 || err.status === 529;
    }
    return false;
  }
}
```

## What's missing from this sketch (intentionally)

1. **Streaming.** This sketch returns the final answer as a single string. Real implementation uses `client.messages.stream(...)` with token-level callbacks via `onToken`. Streaming + tool-use is non-trivial; defer wiring to Phase 3 mid-session.
2. **The `readVaultFile` adapter.** Throws in this sketch. Real impl injects Obsidian's `App.vault.adapter.read(path)` as a constructor dep.
3. **Conversation history persistence.** History passed in by caller; agent doesn't load it. The caller (`ChatView`) manages history lifecycle and persistence.
4. **Streaming tool-use.** When tool-use arrives during a streaming response, you have to pause the stream, execute tools, then resume. Implementation detail for Phase 3.
5. **Cancellation.** No `AbortController`. Add to constructor or per-call signature in Phase 3 once we have a side panel that needs to cancel mid-turn.
6. **Voyage path.** Sketch only handles local retrieval. v0.2 adds Voyage opt-in.
7. **Caching tuning.** `cache_control: { type: "ephemeral" }` is set on big static blocks; real perf tuning happens after first measurement.

## Companion classes (also Phase 2 deliverables)

These will live in `src/`:

| Class | File | Phase 2 / 3 task |
|---|---|---|
| `ToolRegistry` | `src/agent/ToolRegistry.ts` | Owns the 5 v0.1 tools. Each tool: name + schema + handler + tests. Phase 3. |
| `RetrievalLayer` | `src/retrieval/RetrievalLayer.ts` | Implements `queryUnified` per embedding contract §6. Phase 3. |
| `EmbedClient` | `src/retrieval/EmbedClient.ts` | Wraps `@xenova/transformers` to load `all-MiniLM-L6-v2` + encode queries. Phase 3. |
| `BudgetTracker` | `src/budget/BudgetTracker.ts` | Reads/writes `budget.json` in plugin data dir. Daily reset. Phase 2. |
| `ConversationLogger` | `src/log/ConversationLogger.ts` | Appends to `70-Memory/conversations/YYYY-MM-DD/{session}.md`. Phase 3. |
| `ChatView` | `src/views/ChatView.ts` | The side panel. Extends Obsidian `ItemView`. Phase 3. |
| `QuickQuestionModal` | `src/views/QuickQuestionModal.ts` | The Cmd+P modal. Extends Obsidian `Modal`. Phase 3. |
| `SagittariusSettingTab` | `src/settings/SagittariusSettingTab.ts` | Settings UI. Phase 2. |

## Test strategy for ConduitAgent (vitest)

```typescript
// test/agent/ConduitAgent.spec.ts (Phase 3)
describe("ConduitAgent", () => {
  it("returns end_turn after a single non-tool turn");
  it("executes tool_use and continues the loop");
  it("hard-caps at MAX_STEPS to prevent runaway");
  it("falls back to Opus on Sonnet 503");
  it("does not call API if budget pre-flight fails");
  it("commits budget after a turn even on partial completion");
  it("logs to ConversationLogger on every turn");
  it("includes pre-retrieved chunks in vault-qa mode but not chat mode");
  it("propagates tool errors as is_error tool_results, not exceptions");
});
```

## Open implementation questions

1. **Cache-breakpoint placement.** The sketch puts `cache_control: ephemeral` on constitution + tools. Should it also be on the Hangar voice spec? Probably yes; that's also static. Tune in Phase 3.
2. **Pre-retrieval-vs-tool-use:** sketch does pre-retrieval for `vault-qa` AND exposes `search_vault` tool. The model can call `search_vault` again mid-turn for follow-up queries. Is the pre-retrieval redundant? Probably useful as a primer; measure in Phase 3.
3. **Token budget for input.** Pre-flight check uses `MAX_OUTPUT_TOKENS` (4096) as the reserve. Should also reserve for input on long histories. Add to Phase 3.

## Related

- [[18-Obsidian-Claude-Plugin/02_SPEC]] — the spec
- [[18-Obsidian-Claude-Plugin/03_PACKAGE_JSON]] — `@anthropic-ai/sdk` pinned here
- [[Assets/code/corpus-ingest/parsers/embed_interface]] — what `RetrievalLayer.queryUnified` honors
- [[20-Decisions/2026-05-04-sagittarius-build-process]] — ADR-010, Phase 3 scope
- [[21-Agents/concierge]] — the Hangar voice loaded into system prompt
- [[THAD_MAN]] — constitution loaded into system prompt
