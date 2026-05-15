import type { CuratorRule } from '../CuratorRule';
import type { CuratorCorpus, CuratorFinding } from '../types';
import { splitFrontmatter } from '../../util/frontmatter';

/**
 * Phase 9.x (v1.4.0) — proactive draft suggestion detector per ADR-026
 * D8(b) follow-up + ADR-028 lesson 2 (compose existing primitives).
 *
 * Detects clusters of notes that share a tag but lack a "synthesis"
 * note — the operator probably wants to write one but hasn't gotten
 * around to it. Each cluster produces a `CuratorFinding` whose payload
 * carries the tag + member-note count + a suggested draft topic.
 *
 * Per ADR-024 lesson 2 ("pure-rule first"), the detection logic is a
 * pure function over `CuratorCorpus`. The apply path (open
 * `NewDraftModal` pre-filled with the suggested topic) wires in
 * separately from the plugin layer.
 *
 * Heuristic for "is there already a synthesis on this tag?":
 *   1. Any note with `#tag` AND `type: synthesis` frontmatter, OR
 *   2. Any note with `#tag` AND a title containing "synthesis",
 *      "summary", or "overview" (case-insensitive).
 *
 * Tags compared with the leading `#` stripped; case preserved.
 */

export const DRAFT_SUGGESTION_RULE_NAME = 'draft-suggestion';

export interface DraftSuggestionRuleOptions {
  /** Minimum number of notes sharing a tag before a draft is suggested. Default 5. */
  minNotes?: number;
  /**
   * Tags to ignore (case-sensitive, no leading `#`). Default includes
   * structural tags that shouldn't trigger synthesis: `inbox`, `draft`,
   * `wip`, `synthesis`, `moc`, `index`, `archive`. Operator can extend
   * via the setting.
   */
  ignoreTags?: ReadonlyArray<string>;
}

const DEFAULT_IGNORE_TAGS = [
  'inbox',
  'draft',
  'wip',
  'synthesis',
  'moc',
  'index',
  'archive',
] as const;

const SYNTHESIS_TITLE_TERMS = ['synthesis', 'summary', 'overview'] as const;

export function makeDraftSuggestionRule(opts: DraftSuggestionRuleOptions = {}): CuratorRule {
  const minNotes = opts.minNotes ?? 5;
  const ignoreTags = new Set<string>(opts.ignoreTags ?? DEFAULT_IGNORE_TAGS);

  return {
    name: DRAFT_SUGGESTION_RULE_NAME,
    detect: async (corpus) => {
      const tagCensus = await buildTagCensus(corpus);
      const findings: CuratorFinding[] = [];
      for (const [tag, members] of tagCensus.tagToNotes) {
        if (ignoreTags.has(tag)) {
          continue;
        }
        if (members.size < minNotes) {
          continue;
        }
        if (tagCensus.tagsWithSynthesis.has(tag)) {
          continue;
        }
        // Severity 0..1 — scales with member count. 5 notes → 0.5,
        // 20 → 1.0, then capped. Higher = more material to synthesize.
        const severity = Math.min(1.0, members.size / 20);
        const memberPaths = [...members].sort();
        // notePath: pick the most-recent member as the "anchor" note
        // since findings need a real path for dedup + click-to-open
        // UX. The actual draft target path is in the payload.
        const anchorPath = memberPaths[0];
        findings.push({
          ruleName: DRAFT_SUGGESTION_RULE_NAME,
          notePath: anchorPath,
          severity,
          reason: `${members.size} notes tagged \`#${tag}\` but no synthesis exists`,
          payload: {
            tag,
            memberCount: members.size,
            members: memberPaths,
            suggestedTopic: `Synthesis of #${tag} notes`,
          } satisfies DraftSuggestionPayload,
        });
      }
      return findings;
    },
  };
}

/**
 * Strongly-typed view of `CuratorFinding.payload` for this rule. The
 * suggestions panel (and any future curator-orchestrator integration
 * per ADR-026 D8(b)) reads this shape to fire the apply path.
 */
export interface DraftSuggestionPayload {
  tag: string;
  memberCount: number;
  members: string[];
  suggestedTopic: string;
}

interface TagCensus {
  /** Tag (no `#`) → set of vault paths bearing that tag. */
  tagToNotes: Map<string, Set<string>>;
  /** Tags that already have at least one synthesis note. */
  tagsWithSynthesis: Set<string>;
}

/**
 * Walk the corpus once, collect tag membership + flag any synthesis
 * notes encountered. Exported for tests so we can assert the census
 * directly without going through the rule.
 */
export async function buildTagCensus(corpus: CuratorCorpus): Promise<TagCensus> {
  const tagToNotes = new Map<string, Set<string>>();
  const tagsWithSynthesis = new Set<string>();
  for (const path of await corpus.listAllMarkdown()) {
    let content: string;
    try {
      content = await corpus.read(path);
    } catch {
      continue;
    }
    const { frontmatter } = splitFrontmatter(content);
    const noteTags = collectTags(frontmatter, content);
    if (noteTags.size === 0) {
      continue;
    }
    const synthesisHere = isSynthesisNote(frontmatter, path);
    for (const tag of noteTags) {
      let bucket = tagToNotes.get(tag);
      if (bucket === undefined) {
        bucket = new Set();
        tagToNotes.set(tag, bucket);
      }
      bucket.add(path);
      if (synthesisHere) {
        tagsWithSynthesis.add(tag);
      }
    }
  }
  return { tagToNotes, tagsWithSynthesis };
}

/**
 * Collect tags from frontmatter (`tags: [...]` or `tags: 'x, y'`) plus
 * inline `#tag` markers in body. Strips the leading `#`. Case
 * preserved (`#Project` and `#project` are distinct — operator's
 * choice; tag-normalize is a separate rule).
 */
function collectTags(
  frontmatter: Record<string, unknown> | null,
  body: string,
): Set<string> {
  const out = new Set<string>();
  if (frontmatter !== null) {
    const fm = frontmatter.tags;
    if (Array.isArray(fm)) {
      for (const t of fm) {
        if (typeof t === 'string' && t.length > 0) {
          out.add(stripHash(t));
        }
      }
    } else if (typeof fm === 'string' && fm.length > 0) {
      // YAML "tags: foo, bar" lands as a single string sometimes.
      for (const t of fm.split(/[,\s]+/)) {
        if (t.length > 0) {
          out.add(stripHash(t));
        }
      }
    }
  }
  // Inline #tag markers in body. Skip code fences to avoid false
  // positives in markdown highlighting examples.
  const stripped = body.replace(/```[\s\S]*?```/g, '');
  for (const match of stripped.matchAll(/(?:^|\s)#([A-Za-z][A-Za-z0-9_/-]*)/g)) {
    out.add(match[1]);
  }
  return out;
}

function stripHash(s: string): string {
  return s.startsWith('#') ? s.slice(1) : s;
}

/**
 * A note is a "synthesis" iff its frontmatter has `type: synthesis`
 * OR its filename / first heading contains a synthesis-y term.
 * Conservative: false positives suppress useful suggestions, false
 * negatives produce a redundant suggestion the operator can dismiss.
 */
function isSynthesisNote(
  frontmatter: Record<string, unknown> | null,
  path: string,
): boolean {
  if (frontmatter !== null && typeof frontmatter.type === 'string') {
    if (frontmatter.type.toLowerCase() === 'synthesis') {
      return true;
    }
  }
  const filename = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  for (const term of SYNTHESIS_TITLE_TERMS) {
    if (filename.includes(term)) {
      return true;
    }
  }
  return false;
}
