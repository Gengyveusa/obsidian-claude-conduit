import type { MessageCreateParams, Message, TextBlock } from '@anthropic-ai/sdk/resources/messages';

import type { MessagesAPI } from '../agent/ConduitAgent';
import type { VaultAdapter } from '../agent/types';
import type { RetrievalLayer } from '../retrieval/RetrievalLayer';

import type { RouteSuggestion } from './types';

/**
 * Phase 5 (Organization Engine) classifier per [ADR-017](../../docs/2026-05-11-adr-017-phase-5-plan.md) D4.
 *
 * Given a note path, produces a `route` suggestion (or null = KEEP) by:
 *   1. Reading the note's content + frontmatter via VaultAdapter.
 *   2. Querying the RetrievalLayer for K similar notes — used as
 *      grounding context so Claude sees what folders similar notes live in.
 *   3. Calling Anthropic with a fixed system prompt (constitution + JSON
 *      schema instructions) + a user message containing the note + similar
 *      notes.
 *   4. Parsing the model's JSON response → `RouteSuggestion`.
 *
 * Default model is Sonnet (per ADR-017 D4 override 2026-05-11). Settings
 * dropdown lets the user downgrade to Haiku for cost or upgrade to Opus
 * for nuance.
 *
 * The classifier runs **outside** the ConduitAgent loop — it's a one-shot
 * call with a fixed prompt, not a conversational interaction. The agent's
 * tool registry is unaffected.
 */
export interface OrganizationClassifierDeps {
  adapter: VaultAdapter;
  retrieval: RetrievalLayer;
  messages: MessagesAPI;
  /** Loaded constitution text (THAD_MAN.md contents). Provides routing context. */
  constitution: string;
  /** Sonnet by default per ADR-017 D4. Settings can override. */
  classifierModel: string;
  /** How many similar notes to fetch as grounding. Default 5 per ADR-017 D4. */
  similarityK?: number;
  /** Test-injectable epoch-ms clock. */
  now?: () => number;
  /** Test-injectable id-generator (6 hex chars). */
  randId?: () => string;
}

export interface ClassificationOutcome {
  /** Null when the classifier said KEEP (note belongs where it is). */
  suggestion: RouteSuggestion | null;
  tokensIn: number;
  tokensOut: number;
  /** Model's raw JSON response, kept for debugging in the SuggestionsView. */
  rawResponse: string;
}

const DEFAULT_K = 5;
const MAX_OUTPUT_TOKENS = 200;

const SYSTEM_INSTRUCTIONS = `You are the routing classifier for an Obsidian vault assistant (Sagittarius).
Given one note plus a sample of similar existing notes (with their folders), decide where the note should live.

Vault constitution (binding context for routing decisions):
---
{{CONSTITUTION}}
---

Reply with EXACTLY one JSON object on a single line — no prose, no markdown fence — matching this schema:

{"folder": "<vault-relative folder path with no trailing slash, OR the literal string KEEP>",
 "confidence": <number from 0 to 1>,
 "reason": "<one sentence explaining your choice, addressed to the user>"}

Rules:
- Use KEEP when the note already lives in a sensible folder (e.g. it's a meeting note already inside a meetings folder).
- The folder must be a real-looking vault path; do not invent obscure folders.
- Confidence reflects how much you'd bet a human would agree.
- Reason should be concrete — name a specific signal (similarity to specific notes, frontmatter clue, naming pattern).
- DO NOT wrap the JSON in markdown code fences. Plain JSON only.`;

/**
 * Construct the classifier. Production wires `messages` to
 * `Anthropic.messages`; tests inject a stub.
 */
export class OrganizationClassifier {
  private readonly deps: OrganizationClassifierDeps;
  private readonly k: number;
  private readonly now: () => number;
  private readonly randId: () => string;

  constructor(deps: OrganizationClassifierDeps) {
    this.deps = deps;
    this.k = deps.similarityK ?? DEFAULT_K;
    this.now = deps.now ?? Date.now;
    this.randId = deps.randId ?? defaultRandId;
  }

  /**
   * Classify a single note for routing. Returns `suggestion: null` if the
   * model said KEEP. Throws if the file doesn't exist; surface errors as
   * "skip this note" upstream rather than blowing up the watcher loop.
   */
  async classifyForRoute(notePath: string): Promise<ClassificationOutcome> {
    if (!(await this.deps.adapter.exists(notePath))) {
      throw new Error(`OrganizationClassifier: ${notePath} does not exist.`);
    }
    const noteContent = await this.deps.adapter.read(notePath);
    const noteExcerpt = noteContent.slice(0, 500);
    const basename = notePath.split('/').pop() ?? notePath;

    // Use the note's basename + first chunk as the retrieval query.
    // Filter out the note itself from the results (don't recommend its own folder).
    const query = `${basename}\n${noteExcerpt}`;
    const allHits = await this.deps.retrieval.queryUnified({
      query,
      limit: this.k + 1,
      sourceDb: 'self',
    });
    const hits = allHits.filter((h) => h.path !== notePath).slice(0, this.k);

    const userMessage = this.buildUserMessage(notePath, noteExcerpt, hits);
    const system = SYSTEM_INSTRUCTIONS.replace('{{CONSTITUTION}}', this.deps.constitution);

    const params: MessageCreateParams = {
      model: this.deps.classifierModel,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: 'user', content: userMessage }],
      stream: false as const,
    };

    const response: Message = await this.deps.messages.create(params);
    const rawText = extractText(response);

    const parsed = parseClassifierResponse(rawText);

    if (parsed.folder === 'KEEP') {
      return {
        suggestion: null,
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
        rawResponse: rawText,
      };
    }

    const id = `${this.now()}-${this.randId()}`;
    const suggestion: RouteSuggestion = {
      kind: 'route',
      id,
      createdAt: Math.floor(this.now() / 1000),
      notePath,
      proposedFolder: stripTrailingSlash(parsed.folder),
      reason: parsed.reason,
      confidence: parsed.confidence,
    };

    return {
      suggestion,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      rawResponse: rawText,
    };
  }

  private buildUserMessage(
    notePath: string,
    noteExcerpt: string,
    hits: Array<{ path: string; score: number }>,
  ): string {
    const lines: string[] = [];
    lines.push(`Note path: ${notePath}`);
    lines.push(`Note body (first 500 chars):`);
    lines.push('"""');
    lines.push(noteExcerpt);
    lines.push('"""');
    lines.push('');
    if (hits.length === 0) {
      lines.push(
        'No similar existing notes found in the vault. Use the constitution + the note content to decide.',
      );
    } else {
      lines.push(`Top ${hits.length} similar existing notes (with folders):`);
      for (const h of hits) {
        const folder = folderOf(h.path);
        lines.push(`- ${h.path}   (folder: ${folder}, similarity: ${h.score.toFixed(2)})`);
      }
    }
    lines.push('');
    lines.push('Where should this note live? Reply with the JSON described in the system prompt.');
    return lines.join('\n');
  }
}

/** Extract the leading text block from an Anthropic Message. */
function extractText(message: Message): string {
  return message.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** Strip a trailing slash. Pure helper. */
function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/** Get the parent folder of a vault-relative path (or '' for root files). */
function folderOf(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  return lastSlash === -1 ? '(root)' : path.slice(0, lastSlash);
}

/** 6 hex chars for the suggestion id suffix. Mirrors TransactionLog. */
function defaultRandId(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
}

interface ParsedResponse {
  folder: string;
  confidence: number;
  reason: string;
}

/**
 * Parse the model's response text. Tolerates whitespace + accidental
 * markdown fences (some models add them despite instructions). Throws
 * with a clear message on malformed JSON or missing fields, so the
 * watcher can log + skip rather than crash.
 *
 * Exported for tests.
 */
export function parseClassifierResponse(raw: string): ParsedResponse {
  let cleaned = raw.trim();
  // Strip ```json ... ``` if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `OrganizationClassifier: response was not valid JSON (${msg}). Got: ${raw.slice(0, 120)}`,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `OrganizationClassifier: response must be a JSON object, got ${typeof parsed}.`,
    );
  }

  const obj = parsed as Record<string, unknown>;
  const folder = obj['folder'];
  const confidence = obj['confidence'];
  const reason = obj['reason'];

  if (typeof folder !== 'string' || folder.length === 0) {
    throw new Error(
      `OrganizationClassifier: response missing string "folder" field. Got: ${JSON.stringify(parsed).slice(0, 120)}`,
    );
  }
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1 || !Number.isFinite(confidence)) {
    throw new Error(
      `OrganizationClassifier: response "confidence" must be a number in [0, 1]. Got: ${String(confidence)}`,
    );
  }
  if (typeof reason !== 'string') {
    throw new Error(
      `OrganizationClassifier: response missing string "reason" field. Got: ${JSON.stringify(parsed).slice(0, 120)}`,
    );
  }

  return { folder, confidence, reason };
}
