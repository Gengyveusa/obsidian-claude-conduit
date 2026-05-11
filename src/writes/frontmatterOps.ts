import { stringify as stringifyYaml } from 'yaml';

import { splitFrontmatter } from '../util/frontmatter';

/** Allowed frontmatter values per ADR-016 D6 — JSON-ish scalars + string arrays. */
export type FrontmatterValue = string | number | boolean | string[];

/**
 * Set (or update) a YAML frontmatter field on `content`. If the file
 * already has a frontmatter block, the field is upserted in place. If
 * not, a new block is prepended.
 *
 * Returns the new full content. Pure — no I/O.
 *
 * @example
 *   setFrontmatterField('body only', 'title', 'Hello')
 *   // → '---\ntitle: Hello\n---\nbody only'
 *
 *   setFrontmatterField('---\ntags: [a]\n---\nbody', 'title', 'New')
 *   // → '---\ntags: [a]\ntitle: New\n---\nbody'
 */
export function setFrontmatterField(
  content: string,
  key: string,
  value: FrontmatterValue,
): string {
  if (key.trim().length === 0) {
    throw new Error('setFrontmatterField: key must be non-empty');
  }

  const { frontmatter, body } = splitFrontmatter(content);

  // If the parse failed (malformed YAML), `splitFrontmatter` returns the
  // raw content as body. Treat that as "no frontmatter block" — overwriting
  // a malformed block silently could destroy user data. The tool's wrapper
  // surfaces this case as an error.
  if (frontmatter === null && content.startsWith('---\n')) {
    throw new Error(
      'setFrontmatterField: existing frontmatter block is malformed YAML; refusing to overwrite.',
    );
  }

  const next: Record<string, unknown> = frontmatter === null ? {} : { ...frontmatter };
  next[key] = value;

  const yamlBlock = stringifyYaml(next).trimEnd();
  return `---\n${yamlBlock}\n---\n${body}`;
}
