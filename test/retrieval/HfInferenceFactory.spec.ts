import { describe, expect, it, vi } from 'vitest';

import { EmbedClient } from '../../src/retrieval/EmbedClient';
import {
  HF_MODEL,
  type InferenceClientLike,
  makeHfInferenceFactory,
} from '../../src/retrieval/HfInferenceFactory';
import { VECTOR_DIM } from '../../src/retrieval/SqliteEngine';

/** A 384-d vector filled with the given value. */
function vec384(fill: number): number[] {
  return new Array<number>(VECTOR_DIM).fill(fill);
}

/**
 * Build a stub `InferenceClientLike` whose `featureExtraction` returns
 * the given raw response. Tracks calls so tests can assert request shape.
 */
function stubClient(response: (number | number[] | number[][])[]): InferenceClientLike {
  return {
    featureExtraction: vi.fn(() => Promise.resolve(response)),
  };
}

describe('makeHfInferenceFactory', () => {
  it('throws synchronously when apiKey is empty (no SDK construction, no network)', () => {
    const factory = makeHfInferenceFactory({ apiKey: '' });
    expect(() => factory()).toThrow(/huggingfaceApiKey is empty/);
  });

  it('encodes a single string by calling featureExtraction and returning a Float32Array', async () => {
    const client = stubClient([vec384(0.5)]);
    const factory = makeHfInferenceFactory({ apiKey: 'hf_test', client });
    const embed = new EmbedClient(factory);

    const out = await embed.encode('hello, vault.');

    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(VECTOR_DIM);
    expect(out[0]).toBeCloseTo(0.5, 5);

    expect(client.featureExtraction).toHaveBeenCalledTimes(1);
    expect(client.featureExtraction).toHaveBeenCalledWith({
      model: HF_MODEL,
      inputs: ['hello, vault.'],
      provider: 'hf-inference',
    });
  });

  it('uses the configured model id when overridden', async () => {
    const client = stubClient([vec384(0.0)]);
    const factory = makeHfInferenceFactory({
      apiKey: 'hf_test',
      client,
      model: 'sentence-transformers/some-other-model',
    });
    const embed = new EmbedClient(factory);

    await embed.encode('hi');

    expect(client.featureExtraction).toHaveBeenCalledWith({
      model: 'sentence-transformers/some-other-model',
      inputs: ['hi'],
      provider: 'hf-inference',
    });
  });

  it('NFC-normalizes inputs at the boundary', async () => {
    const client = stubClient([vec384(0)]);
    const factory = makeHfInferenceFactory({ apiKey: 'hf_test', client });
    const embed = new EmbedClient(factory);

    const decomposed = 'é'; // 'e' + combining acute; NFC composes to single 'é'.
    await embed.encode(decomposed);

    const fe = client.featureExtraction as unknown as ReturnType<typeof vi.fn>;
    const call = fe.mock.calls[0]?.[0] as { inputs: string[] };
    expect(call.inputs[0]).toBe('é');
  });

  it('encodes a batch in a single API call', async () => {
    const client = stubClient([vec384(0.1), vec384(0.2), vec384(0.3)]);
    const factory = makeHfInferenceFactory({ apiKey: 'hf_test', client });
    const embed = new EmbedClient(factory);

    const vectors = await embed.encodeBatch(['a', 'b', 'c']);

    expect(vectors).toHaveLength(3);
    expect(vectors[0][0]).toBeCloseTo(0.1, 5);
    expect(vectors[1][0]).toBeCloseTo(0.2, 5);
    expect(vectors[2][0]).toBeCloseTo(0.3, 5);

    expect(client.featureExtraction).toHaveBeenCalledTimes(1);
  });

  it('wraps SDK errors with actionable context', async () => {
    const client: InferenceClientLike = {
      featureExtraction: vi.fn(() => Promise.reject(new Error('401 Unauthorized'))),
    };
    const factory = makeHfInferenceFactory({ apiKey: 'hf_bad', client });
    const embed = new EmbedClient(factory);

    await expect(embed.encode('hi')).rejects.toThrow(/SDK featureExtraction failed.*401 Unauthorized/);
  });

  it('throws when API returns a wrong-dim vector', async () => {
    const client = stubClient([new Array<number>(100).fill(0)]);
    const factory = makeHfInferenceFactory({ apiKey: 'hf_test', client });
    const embed = new EmbedClient(factory);

    await expect(embed.encode('hi')).rejects.toThrow(/100-d, expected 384-d/);
  });

  it('throws when API returns wrong number of vectors for a batch', async () => {
    const client = stubClient([vec384(0)]); // one vector for three inputs
    const factory = makeHfInferenceFactory({ apiKey: 'hf_test', client });
    const embed = new EmbedClient(factory);

    await expect(embed.encodeBatch(['a', 'b', 'c'])).rejects.toThrow(
      /returned 1 rows for 3 inputs/,
    );
  });

  it('accepts a flat number[] response for a single input (provider variability)', async () => {
    // Some providers return a flat array for single input rather than [[...]].
    const client: InferenceClientLike = {
      featureExtraction: vi.fn(() => Promise.resolve(vec384(0.7))),
    };
    const factory = makeHfInferenceFactory({ apiKey: 'hf_test', client });
    const embed = new EmbedClient(factory);

    const out = await embed.encode('hi');
    expect(out[0]).toBeCloseTo(0.7, 5);
  });

  it('throws on non-array response shape', async () => {
    const client: InferenceClientLike = {
      featureExtraction: vi.fn(() => Promise.resolve('not an array' as unknown as number[][])),
    };
    const factory = makeHfInferenceFactory({ apiKey: 'hf_test', client });
    const embed = new EmbedClient(factory);

    await expect(embed.encode('hi')).rejects.toThrow(/expected array response/);
  });

  it('throws on unexpected response shape (e.g. completely wrong structure)', async () => {
    const client: InferenceClientLike = {
      featureExtraction: vi.fn(() =>
        Promise.resolve([{ unexpected: true }] as unknown as (number | number[] | number[][])[]),
      ),
    };
    const factory = makeHfInferenceFactory({ apiKey: 'hf_test', client });
    const embed = new EmbedClient(factory);

    await expect(embed.encode('hi')).rejects.toThrow(/unexpected shape/);
  });
});
