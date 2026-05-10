import { beforeEach, describe, expect, it } from 'vitest';

import { ConversationLogger } from '../../src/log/ConversationLogger';
import type { VaultAdapter, VaultStat } from '../../src/agent/types';

class FakeVaultAdapter implements VaultAdapter {
  files = new Map<string, string>();
  folders = new Set<string>();
  writes: Array<{ path: string; content: string }> = [];
  mkdirs: string[] = [];

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path) || this.folders.has(path));
  }

  read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`FakeVaultAdapter.read: ${path} not found`);
    }
    return Promise.resolve(content);
  }

  readBinary(_path: string): Promise<ArrayBuffer> {
    return Promise.resolve(new ArrayBuffer(0));
  }

  write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    this.writes.push({ path, content });
    return Promise.resolve();
  }

  writeBinary(_path: string, _content: ArrayBuffer): Promise<void> {
    return Promise.resolve();
  }

  mkdir(path: string): Promise<void> {
    this.folders.add(path);
    this.mkdirs.push(path);
    return Promise.resolve();
  }

  stat(_path: string): Promise<VaultStat | null> {
    return Promise.resolve(null);
  }

  list(_path: string): Promise<{ files: string[]; folders: string[] }> {
    return Promise.resolve({ files: [], folders: [] });
  }
  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

let adapter: FakeVaultAdapter;
let mockNow: Date;

beforeEach(() => {
  adapter = new FakeVaultAdapter();
  mockNow = new Date('2026-05-04T19:00:00Z');
});

function clock(): Date {
  return mockNow;
}

describe('ConversationLogger', () => {
  it('startSession returns a session whose path follows YYYY-MM-DD/<id>.md', () => {
    const logger = new ConversationLogger(adapter, '70-Memory/conversations', clock, () => 'abc');
    const session = logger.startSession('claude-sonnet-4-6');
    expect(session.id).toBe('abc');
    expect(session.filePath()).toBe('70-Memory/conversations/2026-05-04/abc.md');
  });

  it('append() creates the day folder + writes the file with frontmatter', async () => {
    const logger = new ConversationLogger(adapter, '70-Memory/conversations', clock, () => 'sess1');
    const session = logger.startSession('claude-sonnet-4-6');

    await session.append({
      userMessage: 'Where does Phase 1 stand?',
      assistantMessage: '14/16 SENT.',
      mode: 'vault-qa',
      model: 'claude-sonnet-4-6',
      tokensIn: 800,
      tokensOut: 200,
      costUsd: 0.0054,
      citations: [
        {
          path: '50-FortressFlow/Pipeline_State.md',
          chunkIndex: 0,
          score: 0.91,
          snippet: 'Status: 14 of 16 live contacts SENT, 2 REPLIED.',
        },
      ],
      notesReferenced: ['50-FortressFlow/Pipeline_State.md'],
      toolsUsed: ['search_vault'],
      stepCount: 2,
      durationMs: 1234,
    });

    expect(adapter.mkdirs).toContain('70-Memory/conversations/2026-05-04');
    expect(adapter.writes).toHaveLength(1);
    const content = adapter.writes[0].content;
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('type: conversation');
    expect(content).toContain('session_id: sess1');
    expect(content).toContain('model: claude-sonnet-4-6');
    expect(content).toContain('total_tokens: 1000');
    expect(content).toContain('turn_count: 1');
    expect(content).toContain('total_cost_usd: 0.0054');
    expect(content).toContain('## User\n\nWhere does Phase 1 stand?');
    expect(content).toContain('## Sagittarius\n\n14/16 SENT.');
    expect(content).toContain('### Citations');
    expect(content).toContain('[[50-FortressFlow/Pipeline_State.md]] (0.91)');
  });

  it('rewrites the file with running totals on subsequent appends', async () => {
    const logger = new ConversationLogger(adapter, 'log', clock, () => 'sess');
    const session = logger.startSession('claude-sonnet-4-6');

    const baseTurn = {
      userMessage: 'q',
      assistantMessage: 'a',
      mode: 'chat' as const,
      model: 'claude-sonnet-4-6',
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.001,
      citations: [],
      notesReferenced: [],
      toolsUsed: [],
      stepCount: 1,
      durationMs: 100,
    };
    await session.append(baseTurn);
    await session.append(baseTurn);
    await session.append(baseTurn);

    expect(adapter.writes).toHaveLength(3);
    const final = adapter.writes[2].content;
    expect(final).toContain('turn_count: 3');
    expect(final).toContain('total_tokens: 450'); // 3 × 150
    expect(final).toContain('total_cost_usd: 0.0030');
  });

  it('lists referenced notes in frontmatter without duplicates', async () => {
    const logger = new ConversationLogger(adapter, 'log', clock, () => 'sess');
    const session = logger.startSession('claude-sonnet-4-6');
    const cite = (path: string) => ({
      path,
      chunkIndex: 0,
      score: 0.8,
      snippet: 'snippet',
    });
    await session.append({
      userMessage: 'q',
      assistantMessage: 'a',
      mode: 'chat',
      model: 'claude-sonnet-4-6',
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      citations: [cite('a.md'), cite('b.md'), cite('a.md')],
      notesReferenced: [],
      toolsUsed: ['search_vault'],
      stepCount: 1,
      durationMs: 1,
    });
    const content = adapter.writes[0].content;
    expect(content).toMatch(/notes_referenced: \[\[\[a\.md\]\], \[\[b\.md\]\]\]/);
  });

  it('omits the citations section for turns with no citations', async () => {
    const logger = new ConversationLogger(adapter, 'log', clock, () => 'sess');
    const session = logger.startSession('claude-sonnet-4-6');
    await session.append({
      userMessage: 'q',
      assistantMessage: 'a',
      mode: 'chat',
      model: 'claude-sonnet-4-6',
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      citations: [],
      notesReferenced: [],
      toolsUsed: [],
      stepCount: 1,
      durationMs: 1,
    });
    expect(adapter.writes[0].content).not.toContain('### Citations');
  });

  it('frontmatter tools_used + notes_referenced come from explicit fields (not inferred)', async () => {
    const logger = new ConversationLogger(adapter, 'log', clock, () => 'sess');
    const session = logger.startSession('claude-sonnet-4-6');
    await session.append({
      userMessage: 'summarize a.md',
      assistantMessage: 'done',
      mode: 'chat',
      model: 'claude-sonnet-4-6',
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      citations: [], // no search_vault hit
      notesReferenced: ['a.md', 'b.md'],
      toolsUsed: ['read_note', 'list_folder'],
      stepCount: 2,
      durationMs: 50,
    });
    const content = adapter.writes[0].content;
    expect(content).toContain('tools_used: [read_note, list_folder]');
    expect(content).toMatch(/notes_referenced: \[\[\[a\.md\]\], \[\[b\.md\]\]\]/);
  });

  it('merges notesReferenced + citation paths in frontmatter without duplicates', async () => {
    const logger = new ConversationLogger(adapter, 'log', clock, () => 'sess');
    const session = logger.startSession('claude-sonnet-4-6');
    await session.append({
      userMessage: 'q',
      assistantMessage: 'a',
      mode: 'vault-qa',
      model: 'claude-sonnet-4-6',
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
      citations: [{ path: 'shared.md', chunkIndex: 0, score: 0.9, snippet: 's' }],
      notesReferenced: ['shared.md', 'extra.md'],
      toolsUsed: ['search_vault', 'read_note'],
      stepCount: 1,
      durationMs: 1,
    });
    const content = adapter.writes[0].content;
    // Inspect just the frontmatter (everything before the closing ---).
    const frontmatter = content.slice(0, content.indexOf('\n---\n', 4));
    const matches = frontmatter.match(/\[\[shared\.md\]\]/g) ?? [];
    expect(matches.length).toBe(1);
    expect(frontmatter).toContain('[[extra.md]]');
  });

  it('default idGen produces unique-looking session ids', () => {
    const logger = new ConversationLogger(adapter, 'log', clock);
    const a = logger.startSession('m');
    const b = logger.startSession('m');
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
  });
});
