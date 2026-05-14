import type { MessagesAPI } from '../agent/ConduitAgent';
import type { LlmJudge } from './rules/DuplicateCandidateRule';
import type { TagNormalizeLlmJudge } from './rules/TagNormalizeRule';

/**
 * Phase 7 v1.0.4 — production LLM judges backing the LLM-judged curator
 * rules per ADR-024 follow-up (the wiring half of lesson 1: "ship the
 * rule + the production judge in the same slice").
 *
 * Both judges:
 *   - target Haiku 4.5 by default (cheap, fast, plenty for binary judgments)
 *   - cap `max_tokens` aggressively (the response is one word)
 *   - parse the first text block out of the SDK `Message.content` array
 *   - count calls via `callCount` so the caller can attribute LLM spend
 *     per rule in the activity stream
 *   - throw on SDK errors; the caller rule already catches and treats
 *     throws as "no" (safer false-negative than false-positive)
 */

const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Asks Claude whether two notes are duplicates of each other. Returns
 * `true` iff the model's response starts with `YES` (case-insensitive).
 *
 * @example
 *   const judge = new AnthropicDuplicateLlmJudge(client.messages);
 *   const isDup = await judge.judge({ path: 'a.md', content: '...' }, { path: 'b.md', content: '...' });
 */
export class AnthropicDuplicateLlmJudge implements LlmJudge {
  callCount = 0;

  constructor(
    private readonly messages: MessagesAPI,
    private readonly model: string = DEFAULT_JUDGE_MODEL,
  ) {}

  async judge(
    a: { path: string; content: string },
    b: { path: string; content: string },
  ): Promise<boolean> {
    this.callCount += 1;
    const resp = await this.messages.create({
      model: this.model,
      max_tokens: 16,
      messages: [
        {
          role: 'user',
          content:
            'You are reviewing two markdown notes from a personal vault for ' +
            'possible deduplication.\n\n' +
            'Two notes are duplicates if they cover the same specific topic — ' +
            'so one supersedes or restates the other and they could safely be ' +
            'merged. Two notes that share a topic but cover different angles ' +
            '(e.g. a meeting note vs the project page) are NOT duplicates.\n\n' +
            'Reply with exactly one word: YES or NO.\n\n' +
            `--- NOTE A: ${a.path} ---\n${a.content}\n\n` +
            `--- NOTE B: ${b.path} ---\n${b.content}`,
        },
      ],
    });
    const text = extractText(resp).trim().toUpperCase();
    return text.startsWith('YES');
  }
}

/**
 * Asks Claude whether a cluster of tags refers to the same concept and,
 * if so, which form is canonical. Returns the canonical tag (lowercase,
 * no leading `#`) or `null` if the model declines.
 *
 * Rejects the LLM's pick if it isn't a member of the input cluster —
 * the caller's apply path can only rewrite to a tag that already exists
 * somewhere, so a hallucinated canonical is unsafe.
 *
 * @example
 *   const judge = new AnthropicTagNormalizeLlmJudge(client.messages);
 *   const canonical = await judge.judge(['project', 'projects', 'proj']);
 */
export class AnthropicTagNormalizeLlmJudge implements TagNormalizeLlmJudge {
  callCount = 0;

  constructor(
    private readonly messages: MessagesAPI,
    private readonly model: string = DEFAULT_JUDGE_MODEL,
  ) {}

  async judge(cluster: string[]): Promise<string | null> {
    this.callCount += 1;
    const resp = await this.messages.create({
      model: this.model,
      max_tokens: 32,
      messages: [
        {
          role: 'user',
          content:
            'These tags all appear in the same personal-knowledge vault: ' +
            cluster.map((t) => `#${t}`).join(', ') +
            '\n\n' +
            'Do they all refer to the same concept (just typo, case, or ' +
            'singular/plural variations of each other)?\n\n' +
            'If YES, reply with exactly the canonical tag name — no `#`, no ' +
            'other words, no punctuation. Pick from the list above.\n' +
            'If NO, reply with exactly: NO',
        },
      ],
    });
    const text = extractText(resp).trim();
    if (text.length === 0 || text.toUpperCase() === 'NO') {
      return null;
    }
    const canonical = text
      .replace(/^#/, '')
      .split(/\s/)[0]
      .toLowerCase();
    const lowerCluster = cluster.map((t) => t.toLowerCase());
    if (!lowerCluster.includes(canonical)) {
      return null;
    }
    return canonical;
  }
}

interface MessageContentTextBlock {
  type: string;
  text?: string;
}
interface MessageLike {
  content: MessageContentTextBlock[];
}

/** Extract the first text block's content from an Anthropic Message. Exported for tests. */
export function extractText(resp: MessageLike): string {
  for (const block of resp.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return '';
}
