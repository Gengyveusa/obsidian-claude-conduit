import { describe, expect, it } from 'vitest';

import type { VaultAdapter, VaultStat } from '../../src/agent/types';
import type {
  ClassificationOutcome,
  OrganizationClassifier,
} from '../../src/organization/OrganizationClassifier';
import {
  OrganizationWatcher,
  type VaultEventEmitter,
} from '../../src/organization/OrganizationWatcher';
import { JsonSuggestionQueue } from '../../src/organization/SuggestionQueue';
import type { RouteSuggestion } from '../../src/organization/types';

class MemAdapter implements VaultAdapter {
  files = new Map<string, string>();
  markdownPaths: string[] = [];

  exists(p: string): Promise<boolean> {
    return Promise.resolve(this.files.has(p));
  }
  read(p: string): Promise<string> {
    const v = this.files.get(p);
    return v === undefined ? Promise.reject(new Error(`ENOENT: ${p}`)) : Promise.resolve(v);
  }
  write(p: string, c: string): Promise<void> {
    this.files.set(p, c);
    return Promise.resolve();
  }
  readBinary(): Promise<ArrayBuffer> {
    throw new Error('unused');
  }
  writeBinary(): Promise<void> {
    throw new Error('unused');
  }
  delete(): Promise<void> {
    throw new Error('unused');
  }
  renameFile(): Promise<void> {
    throw new Error('unused');
  }
  mkdir(): Promise<void> {
    return Promise.resolve();
  }
  stat(): Promise<VaultStat | null> {
    return Promise.resolve(null);
  }
  list(): Promise<{ files: string[]; folders: string[] }> {
    return Promise.resolve({ files: [], folders: [] });
  }
  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve(this.markdownPaths);
  }
}

/** Tiny in-memory event emitter — call `fireCreate` / `fireDelete` from tests. */
class FakeEmitter implements VaultEventEmitter {
  private createHandlers: Array<(p: string) => void> = [];
  private deleteHandlers: Array<(p: string) => void> = [];

  onCreate(h: (p: string) => void): () => void {
    this.createHandlers.push(h);
    return () => {
      this.createHandlers = this.createHandlers.filter((x) => x !== h);
    };
  }
  onDelete(h: (p: string) => void): () => void {
    this.deleteHandlers.push(h);
    return () => {
      this.deleteHandlers = this.deleteHandlers.filter((x) => x !== h);
    };
  }
  fireCreate(p: string): void {
    for (const h of this.createHandlers) {
      h(p);
    }
  }
  fireDelete(p: string): void {
    for (const h of this.deleteHandlers) {
      h(p);
    }
  }
  hasCreateSubscribers(): boolean {
    return this.createHandlers.length > 0;
  }
  hasDeleteSubscribers(): boolean {
    return this.deleteHandlers.length > 0;
  }
}

/** Manual-fire fake clock. */
function fakeClock(): {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  fireAll: () => void;
  pending(): number;
} {
  const pending = new Map<number, { cb: () => void; ms: number }>();
  let nextId = 1;
  return {
    setTimeout: (cb, ms) => {
      const id = nextId++;
      pending.set(id, { cb, ms });
      return id;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
    fireAll: () => {
      const snapshot = Array.from(pending.entries());
      pending.clear();
      for (const [, { cb }] of snapshot) {
        cb();
      }
    },
    pending: () => pending.size,
  };
}

/** Build a classifier stub that returns the given outcomes in order, then errors. */
function fakeClassifier(
  outcomes: Array<RouteSuggestion | null | Error>,
): OrganizationClassifier & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    classifyForRoute: (path: string): Promise<ClassificationOutcome> => {
      calls.push(path);
      const next = outcomes[i++];
      if (next instanceof Error) {
        return Promise.reject(next);
      }
      return Promise.resolve({
        suggestion: next,
        tokensIn: 50,
        tokensOut: 20,
        rawResponse: '{}',
      });
    },
  } as unknown as OrganizationClassifier & { calls: string[] };
}

function route(over: Partial<RouteSuggestion> = {}): RouteSuggestion {
  return {
    kind: 'route',
    id: 'id-1',
    createdAt: 1700000000,
    notePath: '10-Inbox/foo.md',
    proposedFolder: '70-Memory/notes',
    reason: 'similar notes live there',
    confidence: 0.8,
    ...over,
  };
}

const QUEUE_PATH = '.obsidian/plugins/obsidian-claude-conduit/suggestions.json';

interface Harness {
  adapter: MemAdapter;
  queue: JsonSuggestionQueue;
  classifier: OrganizationClassifier & { calls: string[] };
  events: FakeEmitter;
  clock: ReturnType<typeof fakeClock>;
  watcher: OrganizationWatcher;
}

function makeHarness(opts: {
  enabled?: boolean;
  watched?: string[];
  classifierOutcomes?: Array<RouteSuggestion | null | Error>;
}): Harness {
  const adapter = new MemAdapter();
  const queue = new JsonSuggestionQueue({ adapter, path: QUEUE_PATH });
  const classifier = fakeClassifier(opts.classifierOutcomes ?? []);
  const events = new FakeEmitter();
  const clock = fakeClock();
  const watcher = new OrganizationWatcher({
    classifier,
    queue,
    events,
    adapter,
    enabled: opts.enabled ?? true,
    watchedFolders: opts.watched ?? ['10-Inbox/'],
    debounceMs: 100,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    logger: { warn: () => {/* swallow in tests */} },
  });
  return { adapter, queue, classifier, events, clock, watcher };
}

describe('OrganizationWatcher — start/stop', () => {
  it('start subscribes to create + delete events; stop unsubscribes', () => {
    const h = makeHarness({});
    expect(h.events.hasCreateSubscribers()).toBe(false);
    h.watcher.start();
    expect(h.events.hasCreateSubscribers()).toBe(true);
    expect(h.events.hasDeleteSubscribers()).toBe(true);
    h.watcher.stop();
    expect(h.events.hasCreateSubscribers()).toBe(false);
    expect(h.events.hasDeleteSubscribers()).toBe(false);
  });

  it('start is idempotent', () => {
    const h = makeHarness({});
    h.watcher.start();
    h.watcher.start();
    // Each event handler still fires only once
    h.events.fireCreate('10-Inbox/foo.md');
    expect(h.clock.pending()).toBe(1);
  });

  it('stop cancels pending debounce timers', () => {
    const h = makeHarness({});
    h.watcher.start();
    h.events.fireCreate('10-Inbox/foo.md');
    expect(h.clock.pending()).toBe(1);
    h.watcher.stop();
    expect(h.clock.pending()).toBe(0);
  });
});

describe('OrganizationWatcher — debounced classification', () => {
  it('debounces — multiple events for the same path schedule only one classify', async () => {
    const h = makeHarness({
      classifierOutcomes: [route()],
    });
    h.watcher.start();
    h.events.fireCreate('10-Inbox/foo.md');
    h.events.fireCreate('10-Inbox/foo.md');
    h.events.fireCreate('10-Inbox/foo.md');
    expect(h.clock.pending()).toBe(1); // last timer wins; earlier ones cleared
    h.clock.fireAll();
    // Allow the awaited classifyNote() inside the timer cb to settle
    await flush();
    expect(h.classifier.calls).toEqual(['10-Inbox/foo.md']);
    expect(await h.queue.size()).toBe(1);
  });

  it('different paths get independent timers', () => {
    const h = makeHarness({});
    h.watcher.start();
    h.events.fireCreate('10-Inbox/a.md');
    h.events.fireCreate('10-Inbox/b.md');
    expect(h.clock.pending()).toBe(2);
  });

  it('events for paths outside watched folders are ignored', () => {
    const h = makeHarness({});
    h.watcher.start();
    h.events.fireCreate('70-Memory/elsewhere.md');
    expect(h.clock.pending()).toBe(0);
  });

  it('events while disabled are dropped', () => {
    const h = makeHarness({ enabled: false });
    h.watcher.start();
    h.events.fireCreate('10-Inbox/foo.md');
    expect(h.clock.pending()).toBe(0);
  });
});

describe('OrganizationWatcher — classifyNote', () => {
  it('returns disabled skip when off', async () => {
    const h = makeHarness({ enabled: false });
    const out = await h.watcher.classifyNote('10-Inbox/foo.md');
    expect(out).toEqual({ enqueued: false, skipped: 'disabled' });
  });

  it('skips paths outside watched folders', async () => {
    const h = makeHarness({});
    const out = await h.watcher.classifyNote('99-Other/x.md');
    expect(out.skipped).toBe('not-in-watched-folder');
  });

  it('skips when a suggestion already exists for this note (dedup)', async () => {
    const h = makeHarness({});
    await h.queue.add(route({ notePath: '10-Inbox/dup.md' }));
    const out = await h.watcher.classifyNote('10-Inbox/dup.md');
    expect(out.skipped).toBe('already-in-queue');
    expect(h.classifier.calls).toEqual([]);
  });

  it('records classifier-error on classifier throw and does not crash', async () => {
    const h = makeHarness({
      classifierOutcomes: [new Error('rate-limited')],
    });
    const out = await h.watcher.classifyNote('10-Inbox/foo.md');
    expect(out.skipped).toBe('classifier-error');
    expect(out.error).toMatch(/rate-limited/);
    expect(await h.queue.size()).toBe(0);
  });

  it('returns classifier-said-keep when classifier outputs null', async () => {
    const h = makeHarness({ classifierOutcomes: [null] });
    const out = await h.watcher.classifyNote('10-Inbox/foo.md');
    expect(out.skipped).toBe('classifier-said-keep');
    expect(await h.queue.size()).toBe(0);
  });

  it('enqueues a suggestion on the happy path', async () => {
    const h = makeHarness({
      classifierOutcomes: [route({ notePath: '10-Inbox/foo.md' })],
    });
    const out = await h.watcher.classifyNote('10-Inbox/foo.md');
    expect(out.enqueued).toBe(true);
    expect(await h.queue.size()).toBe(1);
  });
});

describe('OrganizationWatcher — sweep', () => {
  it('classifies every file in watched folders, skipping already-queued', async () => {
    const h = makeHarness({
      classifierOutcomes: [
        route({ notePath: '10-Inbox/a.md', id: 'a' }),
        null, // KEEP for b.md
        route({ notePath: '10-Inbox/c.md', id: 'c' }),
      ],
    });
    h.adapter.markdownPaths = [
      '10-Inbox/a.md',
      '10-Inbox/b.md',
      '10-Inbox/c.md',
      '70-Memory/skip.md', // outside watched — must be skipped
    ];

    const summary = await h.watcher.sweep();
    expect(summary).toEqual({ classified: 2, skipped: 1, errors: 0 });
    expect(h.classifier.calls).toEqual(['10-Inbox/a.md', '10-Inbox/b.md', '10-Inbox/c.md']);
  });

  it('counts classifier errors separately', async () => {
    const h = makeHarness({
      classifierOutcomes: [new Error('boom'), route({ notePath: '10-Inbox/b.md' })],
    });
    h.adapter.markdownPaths = ['10-Inbox/a.md', '10-Inbox/b.md'];
    const summary = await h.watcher.sweep();
    expect(summary).toEqual({ classified: 1, skipped: 0, errors: 1 });
  });

  it('returns zero counts when disabled', async () => {
    const h = makeHarness({ enabled: false });
    h.adapter.markdownPaths = ['10-Inbox/a.md'];
    const summary = await h.watcher.sweep();
    expect(summary).toEqual({ classified: 0, skipped: 0, errors: 0 });
  });
});

describe('OrganizationWatcher — delete cleanup', () => {
  it('removes any queued suggestion when its note is deleted', async () => {
    const h = makeHarness({});
    await h.queue.add(route({ id: 'r1', notePath: '10-Inbox/zombie.md' }));
    expect(await h.queue.size()).toBe(1);

    h.watcher.start();
    h.events.fireDelete('10-Inbox/zombie.md');
    await flush();
    expect(await h.queue.size()).toBe(0);
  });

  it('is a no-op when the deleted file had no queued suggestion', async () => {
    const h = makeHarness({});
    h.watcher.start();
    h.events.fireDelete('10-Inbox/nothing.md');
    await flush();
    expect(await h.queue.size()).toBe(0);
  });
});

describe('OrganizationWatcher — runtime config updates', () => {
  it('setEnabled(false) clears pending debounce timers', () => {
    const h = makeHarness({});
    h.watcher.start();
    h.events.fireCreate('10-Inbox/foo.md');
    expect(h.clock.pending()).toBe(1);

    h.watcher.setEnabled(false);
    expect(h.clock.pending()).toBe(0);
  });

  it('setWatchedFolders takes effect immediately', () => {
    const h = makeHarness({ watched: ['10-Inbox/'] });
    h.watcher.start();
    h.watcher.setWatchedFolders(['99-Other/']);
    h.events.fireCreate('10-Inbox/foo.md'); // was watched, now isn't
    expect(h.clock.pending()).toBe(0);
    h.events.fireCreate('99-Other/x.md'); // newly watched
    expect(h.clock.pending()).toBe(1);
  });
});

/** Yield to the microtask queue so awaited classifyNote calls inside timer cbs settle. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

