import { parse as parseYaml } from 'yaml';

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Split a markdown file's content into parsed frontmatter and body.
 * Malformed YAML returns null frontmatter and the raw original content
 * (including delimiters) as body, so callers always have something to
 * work with.
 *
 * @example
 *   const { frontmatter, body } = splitFrontmatter(raw);
 */
export function splitFrontmatter(raw: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  const match = FRONTMATTER_REGEX.exec(raw);
  if (!match) {
    return { frontmatter: null, body: raw };
  }
  const yamlText = match[1];
  const body = raw.slice(match[0].length);
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return { frontmatter: null, body: raw };
  }
  if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { frontmatter: null, body };
  }
  return { frontmatter: parsed as Record<string, unknown>, body };
}
