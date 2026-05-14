import type {
  Message,
  MessageCreateParams,
  TextBlock,
} from '@anthropic-ai/sdk/resources/messages';

import type { BudgetTracker } from '../budget/BudgetTracker';
import type { RetrievalLayer } from '../retrieval/RetrievalLayer';
import type { QueryResult } from '../retrieval/types';

import {
  buildDraftFrontmatter,
  extractCitations,
  reconcileCitations,
  validateCitationPolicy,
} from './citationContract';
import { draftPathFor } from './paths';
import type { CitationPolicy, CitedChunk, Draft, DraftSpec } from './types';

/**
 * Phase 8 (v1.1.1) — generative drafting per ADR-026 D2 + D4.
 *
 * Given a topic + retrieval-grounded chunks, produce a cited markdown
 * draft body for the quarantine folder. The engine doesn't write files
 * — it returns a `Draft` that the caller wraps in a `create_note`
 * proposal (D9 (a) — preserve ADR-016 D2: every write through the
 * diff card).
 *
 * Retry semantics per D3 `'strict'`: on first violation the engine
 * resubmits with a "you missed a citation here" instruction; if the
 * second attempt also fails, the draft is returned with
 * `strictFallback: true` and the caller can surface a warning before
 * the diff card opens.
 */

/** Subset of `Anthropic.messages` the drafting engine calls. */
export interface DraftingMessagesAPI {
  create(params: MessageCreateParams): Promise<Message>;
}

const MAX_OUTPUT_TOKENS = 8192;

/** Per-million-token pricing in USD. Mirrors `ConduitAgent.PRICING`. */
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-opus-4-7': { in: 15, out: 75 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
};

/** Live settings the engine reads each call so toggles take effect immediately. */
export interface DraftingEngineSettings {
  draftingModel: string;
  citationPolicy: CitationPolicy;
  draftsDefaultDestination: string;
  retrievalK: number;
}

export interface DraftingEngineDeps {
  messages: DraftingMessagesAPI;
  retrieval: RetrievalLayer;
  budget: BudgetTracker;
  /** Accessor — read on each call so settings flips reflect immediately. */
  settings: () => DraftingEngineSettings;
  /** Test-injectable clock (epoch seconds). */
  clock?: () => number;
  /** Test-injectable logger. */
  logger?: { warn: (msg: string) => void };
}

export interface DraftingEngine {
  generate(spec: DraftSpec): Promise<Draft>;
}

export class AnthropicDraftingEngine implements DraftingEngine {
  private readonly deps: DraftingEngineDeps;
  private readonly clock: () => number;
  private readonly logger: { warn: (msg: string) => void };

  constructor(deps: DraftingEngineDeps) {
    this.deps = deps;
    this.clock = deps.clock ?? (() => Math.floor(Date.now() / 1000));
    this.logger = deps.logger ?? { warn: (m) => console.warn(`[drafting] ${m}`) };
  }

  async generate(spec: DraftSpec): Promise<Draft> {
    const settings = this.deps.settings();
    const destinationFolder =
      spec.destinationFolder ?? settings.draftsDefaultDestination;
    const retrievalLimit = Math.max(
      1,
      spec.retrievalLimit ?? settings.retrievalK * 2,
    );

    const chunks = await this.deps.retrieval.queryUnified({
      query: spec.topic,
      limit: retrievalLimit,
    });
    if (chunks.length === 0) {
      throw new Error(
        `DraftingEngine: no vault chunks matched topic '${spec.topic}'. ` +
          'Build / refresh the retrieval index, or try a more specific topic.',
      );
    }

    const candidate = chunks.map(toCitedChunk);

    // Reserve the output-token budget BEFORE the first call. A draft
    // typically runs 1500-4000 tokens; reserve the cap so cap-busts
    // surface before the network round-trip.
    this.deps.budget.assertAvailable(MAX_OUTPUT_TOKENS);

    const firstAttempt = await this.callModel({
      model: settings.draftingModel,
      systemPrompt: buildSystemPrompt(settings.citationPolicy),
      userMessage: buildUserMessage(spec.topic, chunks),
    });

    let body = firstAttempt.text;
    let strictFallback = false;

    if (settings.citationPolicy !== 'free') {
      const verdict = validateCitationPolicy(body, settings.citationPolicy);
      if (!verdict.ok) {
        this.logger.warn(
          `first draft failed ${settings.citationPolicy} policy: ${verdict.reason}. Retrying once.`,
        );
        // Retry budget check.
        this.deps.budget.assertAvailable(MAX_OUTPUT_TOKENS);
        const second = await this.callModel({
          model: settings.draftingModel,
          systemPrompt: buildSystemPrompt(settings.citationPolicy),
          userMessage:
            buildUserMessage(spec.topic, chunks) +
            '\n\n## Revision note\n\n' +
            `Your previous draft violated the citation contract: ${verdict.reason}. ` +
            'Produce a corrected draft that conforms to the policy.',
        });
        body = second.text;
        const recheck = validateCitationPolicy(body, settings.citationPolicy);
        if (!recheck.ok) {
          this.logger.warn(
            `second draft also failed: ${recheck.reason}. Returning with strictFallback=true.`,
          );
          strictFallback = true;
        }
      }
    }

    const citationRefs = extractCitations(body);
    const { cited } = reconcileCitations(citationRefs, candidate);

    return {
      path: draftPathFor(destinationFolder, spec.topic),
      topic: spec.topic,
      body,
      citedChunks: cited,
      draftingModel: settings.draftingModel,
      generatedAt: this.clock(),
      strictFallback,
    };
  }

  /** One round-trip; bookkeeps cost + tokens through `BudgetTracker`. */
  private async callModel(opts: {
    model: string;
    systemPrompt: string;
    userMessage: string;
  }): Promise<{ text: string }> {
    const response = await this.deps.messages.create({
      model: opts.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: opts.systemPrompt,
      messages: [{ role: 'user', content: opts.userMessage }],
    });

    const text = response.content
      .filter((block): block is TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text.length === 0) {
      throw new Error(
        'DraftingEngine: model returned no text content. Check the API key and try again.',
      );
    }

    const pricing = PRICING[opts.model];
    const tokensIn = response.usage.input_tokens;
    const tokensOut = response.usage.output_tokens;
    const costUsd =
      pricing !== undefined
        ? (tokensIn / 1_000_000) * pricing.in + (tokensOut / 1_000_000) * pricing.out
        : 0;
    await this.deps.budget.commit({ tokensIn, tokensOut, costUsd });
    return { text };
  }
}

/**
 * The first user message sent to the drafting model. Lists the topic
 * + the retrieved chunks in a stable format the citation contract can
 * key against.
 */
export function buildUserMessage(topic: string, chunks: ReadonlyArray<QueryResult>): string {
  const lines: string[] = [`# Topic`, '', topic, '', '# Retrieved chunks', ''];
  for (const c of chunks) {
    lines.push(`## [[${c.path}]] (chunk ${c.chunk}, score ${c.score.toFixed(3)})`);
    lines.push('');
    lines.push(c.text.trim());
    lines.push('');
  }
  lines.push('# Task');
  lines.push('');
  lines.push(
    'Produce a complete markdown draft on the topic, grounded in the chunks above. ' +
      'Output only the markdown body — no preamble, no commentary, no frontmatter ' +
      '(the system will add frontmatter separately).',
  );
  return lines.join('\n');
}

/**
 * System prompt for the drafting model. Keep it tight — the model is
 * already capable; the prompt's job is to lock down output format and
 * the citation contract per the supplied policy.
 *
 * NOT cached at the model boundary (drafting is rare; the system
 * prompt is policy-dependent and tiny — caching gains are negligible).
 */
export function buildSystemPrompt(policy: CitationPolicy): string {
  const policyClause = policyInstructions(policy);
  return [
    'You are Sagittarius, drafting a note for a personal knowledge vault.',
    'You write in clear, direct prose. No buzzword soup. No filler.',
    '',
    'Output format:',
    '- Pure markdown body. No frontmatter, no chat preamble, no commentary.',
    '- Cite vault sources inline with wikilinks: `[[note-path]]` or `[[note-path#header]]`.',
    "- Use the exact `note-path` strings from the retrieved chunks (don't strip `.md`).",
    '- The first heading of your draft becomes the canonical structure; pick it deliberately.',
    '',
    'Citation contract:',
    policyClause,
    '',
    'Quality bar:',
    '- Every cited claim must be supported by the retrieved chunk you cite.',
    '- If the chunks don\'t cover a corner of the topic, say so explicitly rather than inventing.',
    '- Synthesis is welcome — but mark it per the citation contract above.',
  ].join('\n');
}

function policyInstructions(policy: CitationPolicy): string {
  if (policy === 'strict') {
    return [
      '- Every paragraph must include at least one wikilink citation.',
      "- If a paragraph synthesizes without citing, you've violated the contract.",
      '- Skip the paragraph if you can\'t cite it.',
    ].join('\n');
  }
  if (policy === 'marked') {
    return [
      '- Grounded paragraphs cite at least one wikilink.',
      "- Synthesis / transition / framing paragraphs that can't cite a chunk MUST be wrapped",
      '  in HTML comments: `<!-- uncited -->\\nyour synthesis here\\n<!-- /uncited -->`.',
      '- A paragraph that is both cited AND wrapped is a violation — pick one.',
    ].join('\n');
  }
  return [
    '- Cite where you can; uncited prose is allowed unmarked.',
    "- The user has chosen the 'free' policy and accepted the trust trade-off.",
  ].join('\n');
}

function toCitedChunk(q: QueryResult): CitedChunk {
  return {
    notePath: q.path,
    chunkIndex: q.chunk,
    score: q.score,
  };
}

/**
 * Convenience — assemble a draft's frontmatter + body into the final
 * bytes for `create_note`. Centralized here so callers don't need to
 * import from `citationContract` separately.
 */
export function draftToFileContent(draft: Draft): string {
  const frontmatter = buildDraftFrontmatter(draft);
  return `${frontmatter}\n\n${draft.body.trimEnd()}\n`;
}
