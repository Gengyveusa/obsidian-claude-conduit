import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

import { extractCitations } from '../drafts/citationContract';
import { slugifyChat } from './paths';

/**
 * Phase 13 (v1.6.0) — chat-note renderer per ADR-034 D5.
 *
 * Pure module: takes a chat session's history + metadata and produces
 * the `{path-hint, content}` pair the plugin layer wraps in a
 * `create_note` proposal. The plugin handles the actual diff-card
 * flow per ADR-016 D2.
 *
 * Mirrors `AnthropicJournalGenerator` from Phase 12 minus the LLM
 * call — the conversation IS the content; no generation needed.
 *
 * Body format per ADR-034 D4: Q&A H2 blocks per turn, citations
 * preserved as `[[]]` wikilinks (Obsidian's metadata cache builds
 * backlinks automatically). No tool-call traces — operators who want
 * those can read `conversation.log.jsonl`.
 *
 * Frontmatter per ADR-034 D3.
 */

export interface ChatNoteMetadata {
  /** Session start time (epoch ms). */
  startedAt: number;
  /** Session end time (epoch ms). Defaults to `startedAt` for ongoing sessions. */
  endedAt: number;
  /** ChatView mode at save time. */
  mode: 'chat' | 'vault-qa' | 'draft-refine';
  /**
   * Cumulative tokens for the session, if the caller tracked them.
   * Optional — v1.6.0 MVP allows callers without TurnResult access
   * to omit these without breaking the schema.
   */
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

export interface ChatNoteRenderResult {
  /** Suggested slug derived from the first user message. */
  slug: string;
  /** First user message, trimmed — useful for the H1 title. */
  title: string;
  /** Full markdown content (frontmatter + body) ready to write. */
  content: string;
  /** Number of (user, assistant) turn pairs rendered. */
  turnCount: number;
  /** Cited note paths extracted from the assistant turns. */
  citedNotePaths: string[];
}

/**
 * Render a chat-note from history + metadata. The plugin layer
 * computes the destination path via `chatNotePathFor(date, tz, result.slug)`
 * and wraps the content in a `create_note` proposal.
 *
 * @example
 *   const rendered = renderChatNote(chatView.recentHistory(), {
 *     startedAt: sessionStartMs, endedAt: Date.now(), mode: 'chat',
 *   });
 *   await tools.execute('create_note', { path, content: rendered.content });
 */
export function renderChatNote(
  history: ReadonlyArray<MessageParam>,
  metadata: ChatNoteMetadata,
): ChatNoteRenderResult {
  if (history.length === 0) {
    throw new Error('renderChatNote: history is empty — nothing to save.');
  }

  const firstUserContent = textOf(history.find((m) => m.role === 'user')?.content) ?? '';
  const title = firstUserContent.trim().split('\n')[0].slice(0, 80).trim() || 'Conversation';
  const slug = slugifyChat(title);

  // Pair up user → assistant turns. A trailing user message (no
  // response yet) renders without a Sagittarius block.
  const bodyParts: string[] = [];
  let turnCount = 0;
  const citedSet = new Set<string>();
  for (const message of history) {
    const role = message.role;
    const text = textOf(message.content);
    if (text === null || text.trim().length === 0) {
      continue;
    }
    const heading = role === 'user' ? 'Operator' : 'Sagittarius';
    bodyParts.push(`## ${heading}`);
    bodyParts.push('');
    bodyParts.push(text.trim());
    bodyParts.push('');
    if (role === 'assistant') {
      // Per ADR-034 D4: citations stay as `[[]]` wikilinks; we also
      // collect them into frontmatter for D3.
      for (const ref of extractCitations(text)) {
        citedSet.add(ref.notePath);
      }
      turnCount++;
    }
  }

  const citedNotePaths = [...citedSet].sort();
  const frontmatter = buildChatFrontmatter({
    title,
    metadata,
    turnCount,
    citedNotePaths,
  });

  // Assemble.
  const content = `${frontmatter}\n\n# ${title}\n\n${bodyParts.join('\n').trimEnd()}\n`;

  return { slug, title, content, turnCount, citedNotePaths };
}

/**
 * Build the YAML frontmatter per ADR-034 D3.
 *
 * `cited_chunks` mirrors drafting's shape so the citation-drift
 * verifier (v1.3.4) reuses naturally — though for chat notes we only
 * track the note path, not the chunk index. We emit `chunk: null` so
 * the schema is consistent; the drift verifier should treat null
 * chunk as "any chunk on this note resolves" semantics.
 */
function buildChatFrontmatter(opts: {
  title: string;
  metadata: ChatNoteMetadata;
  turnCount: number;
  citedNotePaths: string[];
}): string {
  const { metadata } = opts;
  const lines: string[] = ['---'];
  lines.push("type: 'chat'");
  lines.push(`title: ${yamlString(opts.title)}`);
  lines.push(`session_id: ${yamlString(deriveSessionId(metadata.startedAt))}`);
  lines.push(`started_at: ${Math.floor(metadata.startedAt / 1000)}`);
  lines.push(`ended_at: ${Math.floor(metadata.endedAt / 1000)}`);
  lines.push(`mode: ${yamlString(metadata.mode)}`);
  lines.push(`turn_count: ${opts.turnCount}`);
  if (metadata.tokensIn !== undefined) {
    lines.push(`tokens_in: ${metadata.tokensIn}`);
  }
  if (metadata.tokensOut !== undefined) {
    lines.push(`tokens_out: ${metadata.tokensOut}`);
  }
  if (metadata.costUsd !== undefined) {
    lines.push(`cost_usd: ${metadata.costUsd.toFixed(4)}`);
  }
  if (opts.citedNotePaths.length === 0) {
    lines.push('cited_chunks: []');
  } else {
    lines.push('cited_chunks:');
    for (const path of opts.citedNotePaths) {
      lines.push(`  - { note: ${yamlString(path)}, chunk: null, score: 0 }`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function yamlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Derive a deterministic-ish session id from the start time. Format
 * matches ADR-034 D3's example: 4-hex-suffix + ISO date.
 */
function deriveSessionId(startedAtMs: number): string {
  const iso = new Date(startedAtMs).toISOString().replace(/[:.]/g, '').slice(0, 17);
  // 4 random hex chars to disambiguate if two sessions start in the
  // same minute (rare but possible across two browser tabs).
  const rand = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${rand}-${iso}`;
}

function textOf(content: unknown): string | null {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
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
  return parts.length === 0 ? null : parts.join('\n');
}
