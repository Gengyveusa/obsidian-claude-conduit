import { describe, expect, it } from 'vitest';

import { CuratorOrchestrator } from '../../src/curator/CuratorOrchestrator';
import type { CuratorRule } from '../../src/curator/CuratorRule';
import type { CuratorCorpus, CuratorFinding } from '../../src/curator/types';

class FakeCorpus implements CuratorCorpus {
  listAllMarkdown(): Promise<string[]> {
    return Promise.resolve([]);
  }
  read(): Promise<string> {
    return Promise.resolve('');
  }
  stat(): Promise<null> {
    return Promise.resolve(null);
  }
  outboundLinks(): Promise<string[]> {
    return Promise.resolve([]);
  }
  backlinks(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

function rule(name: string, findings: CuratorFinding[]): CuratorRule {
  return {
    name,
    detect: () => Promise.resolve(findings),
  };
}

function throwingRule(name: string, message: string): CuratorRule {
  return {
    name,
    detect: () => Promise.reject(new Error(message)),
  };
}

function finding(over: Partial<CuratorFinding> = {}): CuratorFinding {
  return {
    ruleName: 'r',
    notePath: 'a.md',
    severity: 0.5,
    reason: '',
    ...over,
  };
}

describe('CuratorOrchestrator', () => {
  it('registers rules and reports their names in order', () => {
    const orch = new CuratorOrchestrator({ corpus: new FakeCorpus() });
    orch.register(rule('alpha', []));
    orch.register(rule('beta', []));
    expect(orch.registeredRuleNames()).toEqual(['alpha', 'beta']);
  });

  it('throws on duplicate rule name', () => {
    const orch = new CuratorOrchestrator({ corpus: new FakeCorpus() });
    orch.register(rule('only-one', []));
    expect(() => orch.register(rule('only-one', []))).toThrow(/already registered/);
  });

  it('aggregates findings across rules', async () => {
    const orch = new CuratorOrchestrator({ corpus: new FakeCorpus() });
    orch.register(rule('alpha', [finding({ notePath: 'x.md', severity: 0.9 })]));
    orch.register(rule('beta', [finding({ notePath: 'y.md', severity: 0.5 })]));
    const outcome = await orch.run();
    expect(outcome.totalDetected).toBe(2);
    expect(outcome.enqueued).toHaveLength(2);
    expect(outcome.errors).toEqual([]);
    expect(outcome.rulesRun).toBe(2);
  });

  it('ranks findings by severity descending', async () => {
    const orch = new CuratorOrchestrator({ corpus: new FakeCorpus() });
    orch.register(rule('a', [
      finding({ notePath: 'low.md', severity: 0.1 }),
      finding({ notePath: 'high.md', severity: 0.95 }),
      finding({ notePath: 'mid.md', severity: 0.5 }),
    ]));
    const outcome = await orch.run();
    expect(outcome.enqueued.map((f) => f.notePath)).toEqual(['high.md', 'mid.md', 'low.md']);
  });

  it('caps at maxPerSweep and reports the rest', async () => {
    const orch = new CuratorOrchestrator({ corpus: new FakeCorpus() });
    const findings: CuratorFinding[] = [];
    for (let i = 0; i < 10; i += 1) {
      findings.push(finding({ notePath: `n${i}.md`, severity: i / 10 }));
    }
    orch.register(rule('many', findings));
    const outcome = await orch.run({ maxPerSweep: 3 });
    expect(outcome.totalDetected).toBe(10);
    expect(outcome.enqueued).toHaveLength(3);
    expect(outcome.capped).toBe(7);
    // Top three are the severity-0.9 / 0.8 / 0.7 ones.
    expect(outcome.enqueued.map((f) => f.notePath)).toEqual(['n9.md', 'n8.md', 'n7.md']);
  });

  it('catches per-rule errors and continues across rules', async () => {
    const orch = new CuratorOrchestrator({
      corpus: new FakeCorpus(),
      logger: { warn: () => {} },
    });
    orch.register(rule('healthy', [finding({ notePath: 'ok.md', severity: 0.8 })]));
    orch.register(throwingRule('broken', 'boom'));
    orch.register(rule('also-healthy', [finding({ notePath: 'ok2.md', severity: 0.6 })]));
    const outcome = await orch.run();
    expect(outcome.totalDetected).toBe(2);
    expect(outcome.errors).toHaveLength(1);
    expect(outcome.errors[0]).toEqual({ ruleName: 'broken', message: 'boom' });
    expect(outcome.rulesRun).toBe(3);
  });

  it('returns empty enqueued list when no rules registered', async () => {
    const orch = new CuratorOrchestrator({ corpus: new FakeCorpus() });
    const outcome = await orch.run();
    expect(outcome.rulesRun).toBe(0);
    expect(outcome.totalDetected).toBe(0);
    expect(outcome.enqueued).toEqual([]);
    expect(outcome.capped).toBe(0);
  });

  it('preserves registration order on severity ties (stable sort)', async () => {
    const orch = new CuratorOrchestrator({ corpus: new FakeCorpus() });
    orch.register(rule('a', [finding({ notePath: 'a1.md', severity: 0.5 })]));
    orch.register(rule('b', [finding({ notePath: 'b1.md', severity: 0.5 })]));
    orch.register(rule('c', [finding({ notePath: 'c1.md', severity: 0.5 })]));
    const outcome = await orch.run();
    expect(outcome.enqueued.map((f) => f.notePath)).toEqual(['a1.md', 'b1.md', 'c1.md']);
  });

  it('reports durationMs from injected clock', async () => {
    let t = 1000;
    const orch = new CuratorOrchestrator({
      corpus: new FakeCorpus(),
      now: () => {
        const v = t;
        t += 250;
        return v;
      },
    });
    orch.register(rule('a', []));
    const outcome = await orch.run();
    // first call captures t0=1000; second call returns 1250.
    expect(outcome.durationMs).toBe(250);
  });

  it('cap == size keeps everything; capped is 0', async () => {
    const orch = new CuratorOrchestrator({ corpus: new FakeCorpus() });
    orch.register(rule('a', [
      finding({ notePath: 'x.md', severity: 0.7 }),
      finding({ notePath: 'y.md', severity: 0.3 }),
    ]));
    const outcome = await orch.run({ maxPerSweep: 2 });
    expect(outcome.capped).toBe(0);
    expect(outcome.enqueued).toHaveLength(2);
  });
});
