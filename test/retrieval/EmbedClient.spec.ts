import { describe, expect, it, vi } from 'vitest';
import {
  EmbedClient,
  type EmbedPipeline,
  type EmbedPipelineFactory,
} from '../../src/retrieval/EmbedClient';
import { VECTOR_DIM } from '../../src/retrieval/SqliteEngine';

// Build a pipeline stub that returns a deterministic vector for any
// (text, opts) call. Mean-pools by averaging codepoints into 384 buckets.
function makeStubPipeline(): EmbedPipeline {
  return (text: string | string[]) => {
    const inputs = Array.isArray(text) ? text : [text];
    const out = new Float32Array(inputs.length * VECTOR_DIM);
    for (let i = 0; i < inputs.length; i++) {
      const s = inputs[i];
      for (let c = 0; c < s.length; c++) {
        const slot = c % VECTOR_DIM;
        out[i * VECTOR_DIM + slot] += s.charCodeAt(c) / 1000;
      }
    }
    return Promise.resolve({ data: out });
  };
}

function stubFactory(): EmbedPipelineFactory {
  const pipeline = makeStubPipeline();
  return () => Promise.resolve(pipeline);
}

describe('EmbedClient', () => {
  it('lazy-loads the pipeline (isLoaded() is false before first encode)', async () => {
    const factory = vi.fn(stubFactory());
    const client = new EmbedClient(factory);
    expect(client.isLoaded()).toBe(false);
    expect(factory).not.toHaveBeenCalled();

    await client.encode('hello');
    expect(client.isLoaded()).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);

    await client.encode('again');
    // Factory invoked exactly once; pipeline is memoized.
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('encode() returns a 384-d Float32Array', async () => {
    const client = new EmbedClient(stubFactory());
    const vec = await client.encode('Hello, vault.');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(VECTOR_DIM);
  });

  it('encode() applies NFC normalization (composed === decomposed)', async () => {
    const client = new EmbedClient(stubFactory());
    // 'é' in NFC (U+00E9, single codepoint) vs NFD (U+0065 U+0301).
    const composed = 'Café';
    const decomposed = 'Café'; // U+0065 U+0301
    expect(composed.normalize('NFC')).toBe(decomposed.normalize('NFC'));
    expect(composed).not.toBe(decomposed);

    const v1 = await client.encode(composed);
    const v2 = await client.encode(decomposed);
    for (let i = 0; i < VECTOR_DIM; i++) {
      expect(v1[i]).toBe(v2[i]);
    }
  });

  it('encodeBatch() returns one vector per input', async () => {
    const client = new EmbedClient(stubFactory());
    const vecs = await client.encodeBatch(['hello', 'world', '!']);
    expect(vecs).toHaveLength(3);
    for (const v of vecs) {
      expect(v.length).toBe(VECTOR_DIM);
    }
  });

  it('encodeBatch([]) returns [] without calling the pipeline', async () => {
    const factory = vi.fn(stubFactory());
    const client = new EmbedClient(factory);
    const vecs = await client.encodeBatch([]);
    expect(vecs).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
  });

  it('throws actionably if the pipeline returns the wrong dimension', async () => {
    const wrongDimFactory: EmbedPipelineFactory = () =>
      Promise.resolve(((_text: string) =>
        Promise.resolve({ data: new Float32Array(100) })) as unknown as EmbedPipeline);
    const client = new EmbedClient(wrongDimFactory);
    await expect(client.encode('hi')).rejects.toThrow(/expected 384/);
  });

  it('throws actionably if encodeBatch returns the wrong number of floats', async () => {
    const wrongShapeFactory: EmbedPipelineFactory = () =>
      Promise.resolve(((_text: string | string[]) =>
        // Should be 2 × 384 = 768; return 384 instead.
        Promise.resolve({ data: new Float32Array(VECTOR_DIM) })) as unknown as EmbedPipeline);
    const client = new EmbedClient(wrongShapeFactory);
    await expect(client.encodeBatch(['a', 'b'])).rejects.toThrow(/expected 768/);
  });
});
