import type { CuratorRule } from '../CuratorRule';
import type { CuratorCorpus, CuratorFinding } from '../types';

/**
 * Phase 7 (v1.0.0) — broken-wikilink detector per ADR-022 D1 (v1 ships).
 *
 * For every note in the corpus, parse the outbound wikilinks and check
 * each target. A target is "broken" if no `.md` file matches its
 * resolved path. Severity is high (0.9) because broken links are
 * unambiguously wrong — there's no judgment call.
 *
 * Pure detector: no LLM, no network, no writes. Deterministic over
 * the same corpus state. Per ADR-022 D3.
 *
 * Match semantics: wikilink target X matches an existing file iff
 * any of these conditions hold:
 *   1. `${target}.md` exists at vault root
 *   2. `${target}.md` exists as a basename anywhere in the vault
 *      (Obsidian's default "shortest-path-when-unique" resolution)
 *   3. A full vault-relative path `${target}.md` exists
 *
 * Targets with slashes (`folder/note`) only check #3 / exact-path.
 *
 * @example finding shape
 *   {
 *     ruleName: 'broken-link',
 *     notePath: '10-Inbox/foo.md',
 *     severity: 0.9,
 *     reason: 'Links to [[Old Note]] but no Old Note.md exists',
 *     payload: { brokenTarget: 'Old Note', linkText: '[[Old Note]]' },
 *   }
 */
export const BROKEN_LINK_RULE_NAME = 'broken-link';

export function makeBrokenLinkRule(): CuratorRule {
  return {
    name: BROKEN_LINK_RULE_NAME,
    detect: (corpus) => detectBrokenLinks(corpus),
  };
}

async function detectBrokenLinks(corpus: CuratorCorpus): Promise<CuratorFinding[]> {
  const allMd = await corpus.listAllMarkdown();
  const allMdSet = new Set(allMd);
  const basenameIndex = new Map<string, number>();
  for (const path of allMd) {
    const base = basenameOf(path);
    basenameIndex.set(base, (basenameIndex.get(base) ?? 0) + 1);
  }
  // Lookup by basename: count > 0 → exists; we don't try to disambiguate
  // multiple matches (Obsidian's resolution prefers shortest-path; for
  // brokenness purposes a single match is enough).

  const findings: CuratorFinding[] = [];
  for (const notePath of allMd) {
    let content: string;
    try {
      content = await corpus.read(notePath);
    } catch {
      // Can't read → can't analyze; skip silently. The orchestrator
      // will surface real errors separately if read throws on every note.
      continue;
    }
    for (const { linkText, target } of extractWikilinks(content)) {
      if (isBroken(target, allMdSet, basenameIndex)) {
        findings.push({
          ruleName: BROKEN_LINK_RULE_NAME,
          notePath,
          severity: 0.9,
          reason: `Links to ${linkText} but no matching note exists`,
          payload: { brokenTarget: target, linkText },
        });
      }
    }
  }
  return findings;
}

/**
 * Parse `[[Target]]` and `[[Target|alias]]` from markdown text.
 * Returns each occurrence — the same target appearing twice yields
 * two findings (the user may want to remove both individually).
 *
 * Skips:
 *   - escaped brackets (`\[[X]]`)
 *   - empty targets (`[[]]`)
 *   - embed syntax (`![[X]]`) treated as a wikilink for our purposes
 *     because Obsidian renders embeds against the same name resolution
 *
 * Exported for tests.
 */
export function extractWikilinks(content: string): Array<{
  linkText: string;
  target: string;
}> {
  const links: Array<{ linkText: string; target: string }> = [];
  const re = /(?<!\\)\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const inner = match[1];
    const pipeIdx = inner.indexOf('|');
    const target = (pipeIdx === -1 ? inner : inner.slice(0, pipeIdx)).trim();
    if (target.length === 0) {
      continue;
    }
    // Strip section anchor (`#Heading`) and block ref (`^block`) — those
    // don't affect existence resolution.
    const cleanTarget = target.replace(/[#^].*$/, '').trim();
    if (cleanTarget.length === 0) {
      continue;
    }
    links.push({ linkText: match[0], target: cleanTarget });
  }
  return links;
}

/**
 * True if `target` doesn't resolve to any markdown file in the vault.
 * Exported for tests.
 */
export function isBroken(
  target: string,
  allMdSet: Set<string>,
  basenameIndex: Map<string, number>,
): boolean {
  // Exact path match (with .md suffix).
  if (allMdSet.has(`${target}.md`)) {
    return false;
  }
  // Already includes .md? — rare but possible.
  if (allMdSet.has(target)) {
    return false;
  }
  // Path with slash: only the exact form should resolve.
  if (target.includes('/')) {
    return true;
  }
  // Basename match anywhere in the vault.
  return (basenameIndex.get(`${target}.md`) ?? 0) === 0;
}

function basenameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}
