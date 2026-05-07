import type { SystemPromptParts } from '../agent/ConduitAgent';
import type { VaultAdapter } from '../agent/types';

const FALLBACK_CONSTITUTION = `# Operator constitution

You are Sagittarius, a Claude-powered conduit running inside the user's
Obsidian vault. You answer questions about the vault grounded in retrieval
when available, citing the notes you consulted.

When you don't know, say "not in the vault" and tell the user where to look.
Do not fabricate.`;

const FALLBACK_HANGAR_VOICE = `# Voice

- Direct. Calm under pressure. Get to the point.
- Cite the file when you used a tool. \`[[Note]]\` syntax.
- No filler ("great question", "I'd be happy to"). No emojis unless the
  user uses them first.
- If the answer is one line, give one line.`;

export interface SystemPromptLoaderOptions {
  constitutionPath: string;
  hangarVoicePath: string;
}

/**
 * Read the constitution + voice files from the vault and return them as
 * SystemPromptParts. Falls back to bundled defaults when either file is
 * missing — community installs without `THAD_MAN.md` still get a working
 * (if generic) system prompt.
 *
 * Reads on every call; cheap (Obsidian's adapter is a thin fs wrapper).
 * If perf becomes a problem we can cache + invalidate on metadataCache
 * change events.
 *
 * @example
 *   const parts = await loadSystemPromptParts(adapter, {
 *     constitutionPath: 'THAD_MAN.md',
 *     hangarVoicePath: '21-Agents/concierge.md',
 *   });
 */
export async function loadSystemPromptParts(
  adapter: VaultAdapter,
  opts: SystemPromptLoaderOptions,
): Promise<SystemPromptParts> {
  const constitution = await readWithFallback(adapter, opts.constitutionPath, FALLBACK_CONSTITUTION);
  const hangarVoice = await readWithFallback(adapter, opts.hangarVoicePath, FALLBACK_HANGAR_VOICE);
  return { constitution, hangarVoice };
}

async function readWithFallback(
  adapter: VaultAdapter,
  path: string,
  fallback: string,
): Promise<string> {
  if (!(await adapter.exists(path))) {
    return fallback;
  }
  try {
    const raw = await adapter.read(path);
    return raw.trim().length > 0 ? raw : fallback;
  } catch {
    // Read failure (permissions, deleted between exists+read) → fallback.
    return fallback;
  }
}

export { FALLBACK_CONSTITUTION, FALLBACK_HANGAR_VOICE };
