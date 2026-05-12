import type {
  Message,
  MessageCreateParams,
  TextBlock,
} from '@anthropic-ai/sdk/resources/messages';

import type { MessagesAPI } from '../agent/ConduitAgent';
import type { VaultAdapter } from '../agent/types';

import type { MocCandidate } from './MocDiscovery';
import type { MocAddSuggestion } from './types';

/**
 * Phase 5 (v0.6.x) — second classifier alongside `OrganizationClassifier`.
 *
 * Where the route classifier asks *which folder* a note belongs to,
 * MocAddClassifier asks *which existing MOC (if any) should reference it*.
 *
 * Single LLM call per note: feeds the model the note body + a digest of
 * candidate MOCs (path, title, link count) and asks it to pick one or
 * answer NONE. Sonnet default per ADR-017 D4 override; users can override
 * via the same `organizationClassifierModel` setting that controls the
 * route classifier.
 *
 * Wiring (PR 3): the watcher invokes this after the route classifier
 * settles. Suggestions land in the same `SuggestionQueue` as a
 * `MocAddSuggestion`; the panel's Apply path routes through `link_notes`.
 */
export interface MocAddClassifierDeps {
  adapter: VaultAdapter;
  messages: MessagesAPI;
  /** Loaded constitution text (THAD_MAN.md). Same as the route classifier. */
  constitution: string;
  /** Per ADR-017 D4 — Sonnet by default; settings dropdown can override. */
  classifierModel: string;
  now?: () => number;
  randId?: () => string;
}

export interface MocAddClassificationOutcome {
  /** Null when classifier said NONE or no candidates were supplied. */
  suggestion: MocAddSuggestion | null;
  tokensIn: number;
  tokensOut: number;
  /** Model's raw JSON response, kept for debugging. */
  rawResponse: string;
}

const MAX_OUTPUT_TOKENS = 200;

const SYSTEM_INSTRUCTIONS = `You are the MOC-membership classifier for an Obsidian vault assistant (Sagittarius).
A Map of Content (MOC) is an index note that lists related notes via [[wikilinks]]. Given one note plus a list of candidate MOCs already present in the vault, decide whether the note belongs in any of them.

Vault constitution (binding context — respects user conventions):
---
{{CONSTITUTION}}
---

Reply with EXACTLY one JSON object on a single line — no prose, no markdown fence — matching this schema:

{"mocPath": "<vault-relative path to one of the candidate MOCs, OR the literal string NONE>",
 "anchor": "<optional: exact heading text inside that MOC where the new link belongs, e.g. '## Recent'. Omit entirely if you have no preference.>",
 "confidence": <number from 0 to 1>,
 "reason": "<one sentence justifying your choice, addressed to the user>"}

Rules:
- Use NONE when the note isn't a strong fit for any candidate. Don't force a match.
- The mocPath, if given, must match one of the candidate paths verbatim.
- Anchor is optional — only include it if the MOC has a section that clearly fits.
- Confidence reflects how strongly you'd bet a human would agree.
- Reason should cite a concrete signal — e.g. matching theme, similar names already on the MOC, related frontmatter.
- DO NOT wrap the JSON in markdown code fences.`;

export class MocAddClassifier {
  private readonly deps: MocAddClassifierDeps;
  private readonly now: () => number;
  private readonly randId: () => string;

  constructor(deps: MocAddClassifierDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.randId = deps.randId ?? defaultRandId;
  }

  /**
   * Classify whether `notePath` belongs in any of the supplied MOCs.
   * Returns `suggestion: null` when:
   *   - `candidates` is empty (no LLM call made — saves cost)
   *   - the model returned NONE
   *   - the model returned a `mocPath` that doesn't match any candidate
   *     (defensive — keeps the queue from carrying suggestions whose
   *     target path won't resolve at Apply time)
   *
   * Throws if `notePath` doesn't exist; the watcher catches + logs.
   */
  async classifyForMocAdd(
    notePath: string,
    candidates: MocCandidate[],
  ): Promise<MocAddClassificationOutcome> {
    if (!(await this.deps.adapter.exists(notePath))) {
      throw new Error(`MocAddClassifier: ${notePath} does not exist.`);
    }

    if (candidates.length === 0) {
      return {
        suggestion: null,
        tokensIn: 0,
        tokensOut: 0,
        rawResponse: '',
      };
    }

    const noteContent = await this.deps.adapter.read(notePath);
    const noteExcerpt = noteContent.slice(0, 500);

    const userMessage = this.buildUserMessage(notePath, noteExcerpt, candidates);
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

    const parsed = parseMocAddResponse(rawText);

    if (parsed.mocPath === 'NONE') {
      return {
        suggestion: null,
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
        rawResponse: rawText,
      };
    }

    // Defensive: the model must pick a path from the candidate list.
    // If it hallucinates a path, drop the suggestion rather than queue
    // a row whose Apply would later fail.
    const matched = candidates.find((c) => c.path === parsed.mocPath);
    if (matched === undefined) {
      return {
        suggestion: null,
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
        rawResponse: rawText,
      };
    }

    const id = `${this.now()}-${this.randId()}`;
    const suggestion: MocAddSuggestion = {
      kind: 'moc-add',
      id,
      createdAt: Math.floor(this.now() / 1000),
      notePath,
      mocPath: matched.path,
      reason: parsed.reason,
      confidence: parsed.confidence,
      ...(parsed.anchor !== undefined && { mocAnchor: parsed.anchor }),
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
    candidates: MocCandidate[],
  ): string {
    const lines: string[] = [];
    lines.push(`Note path: ${notePath}`);
    lines.push('Note body (first 500 chars):');
    lines.push('"""');
    lines.push(noteExcerpt);
    lines.push('"""');
    lines.push('');
    lines.push(`Candidate MOCs in the vault (${candidates.length}):`);
    for (const c of candidates) {
      const title = c.firstHeading ?? c.basename;
      lines.push(`- ${c.path}   (title: "${title}", entries: ${c.wikilinkBulletCount})`);
    }
    lines.push('');
    lines.push('Should this note be added to one of these MOCs? Reply with the JSON described in the system prompt.');
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

/** 6 hex chars for the suggestion id suffix. Mirrors TransactionLog. */
function defaultRandId(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
}

interface ParsedResponse {
  mocPath: string;
  anchor?: string;
  confidence: number;
  reason: string;
}

/**
 * Parse the model's response. Same tolerance as the route classifier:
 * strips markdown fences if accidentally added, throws clearly on missing
 * fields. Exported for tests.
 */
export function parseMocAddResponse(raw: string): ParsedResponse {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `MocAddClassifier: response was not valid JSON (${msg}). Got: ${raw.slice(0, 120)}`,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`MocAddClassifier: response must be a JSON object, got ${typeof parsed}.`);
  }

  const obj = parsed as Record<string, unknown>;
  const mocPath = obj['mocPath'];
  const confidence = obj['confidence'];
  const reason = obj['reason'];
  const anchor = obj['anchor'];

  if (typeof mocPath !== 'string' || mocPath.length === 0) {
    throw new Error(
      `MocAddClassifier: response missing string "mocPath" field. Got: ${JSON.stringify(parsed).slice(0, 120)}`,
    );
  }
  if (
    typeof confidence !== 'number' ||
    confidence < 0 ||
    confidence > 1 ||
    !Number.isFinite(confidence)
  ) {
    throw new Error(
      `MocAddClassifier: response "confidence" must be a number in [0, 1]. Got: ${String(confidence)}`,
    );
  }
  if (typeof reason !== 'string') {
    throw new Error(
      `MocAddClassifier: response missing string "reason" field. Got: ${JSON.stringify(parsed).slice(0, 120)}`,
    );
  }

  const result: ParsedResponse = { mocPath, confidence, reason };
  if (typeof anchor === 'string' && anchor.length > 0) {
    result.anchor = anchor;
  }
  return result;
}
