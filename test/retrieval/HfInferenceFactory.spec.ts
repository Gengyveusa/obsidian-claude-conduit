import { describe, expect, it, vi } from 'vitest';

import { EmbedClient } from '../../src/retrieval/EmbedClient';
import {
  HF_ENDPOINT,
  type FetchLike,
  makeHfInferenceFactory,
} from '../../src/retrieval/HfInferenceFactory';
import { VECTOR_DIM } from '../../src/retrieval/SqliteEngine';

/** Build a fake fetch that returns the given vectors as a 200 OK response. */
function fakeOkFetch(vectors: number[][]): FetchLike {
  return vi.fn(async () =>
    Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(vectors)),
      json: () => Promise.resolve(vectors),
    }),
  );
}

/** A 384-d vector filled with the given value. */
function vec384(fill: number): number[] {
  return new Array<number>(VECTOR_DIM).fill(fill);
}

describe('makeHfInferenceFactory', () => {
  it('throws synchronously when apiKey is empty (no network)', () => {
    const factory = makeHfInferenceFactory({ apiKey: '' });
    expect(() => factory()).toThrow(/huggingfaceApiKey is empty/);
  });

  it('encodes a single string by POSTing to HF and returning a Float32Array', async () => {
    const fetchImpl = fakeOkFetch([vec384(0.5)]);
    const factory = makeHfInferenceFactory({ apiKey: 'hf_test', fetchImpl });
    const client = new EmbedClient(factory);

    const out = await client.encode('hello, vault.');

    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(VECTOR_DIM);
    expect(out[0]).toBeCloseTo(0.5, 5);

    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    const [url, init] = calls[0] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe(HF_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer hf_test');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ inputs: ['hello, vault.'] });
  });

  it('NFC-normalizes inputs at the boundary', async () => {
    const fetchImpl = fakeOkFetch([vec384(0)]);
    const factory = makeHfInferenceFactory({ apiKey: 'hf_test', fetchImpl });
    const client = new EmbedClient(factory);

    // Decomposed: 'e' + combining acute. NFC composes to 'é'.
    const decomposed = 'é';
    await client.encode(decomposed);

    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const body = JSON.parse((calls[0]?.[1] as { body: string }).body) as { inputs: string[] };
    expect(body.inputs[0]).toBe('é'); // NFC form
  });

  it('encodes a batch in a single API call', async () => {
    const fetchImpl = fakeOkFetch([vec384(0.1), vec384(0.2), vec384(0.3)]);
    const factory = makeHfInferenceFactory({ apiKey: 'hf_test', fetchImpl });
    const client = new EmbedClient(factory);

    const vectors = await client.encodeBatch(['a', 'b', 'c']);

    expect(vectors).toHaveLength(3);
    expect(vectors[0][0]).toBeCloseTo(0.1, 5);
    expect(vectors[1][0]).toBeCloseTo(0.2, 5);
    expect(vectors[2][0]).toBeCloseTo(0.3, 5);

    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1); // batched, not one-call-per-input
  });

  it('retries once on HF cold-start 503 with estimated_time hint', async () => {
    const cold = {
      ok: false,
      status: 503,
      text: () =>
        Promise.resolve(
          JSON.stringify({ error: 'Model is currently loading', estimated_time: 1.5 }),
        ),
      json: () =>
        Promise.resolve({ error: 'Model is currently loading', estimated_time: 1.5 }),
    };
    const warm = {
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify([vec384(0.7)])),
      json: () => Promise.resolve([vec384(0.7)]),
    };
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(cold)
      .mockResolvedValueOnce(warm);
    const sleepImpl = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    const factory = makeHfInferenceFactory({ apiKey: 'hf_test', fetchImpl, sleepImpl });
    const client = new EmbedClient(factory);

    const vec = await client.encode('hello');

    // 0.7 isn't representable exactly in f32; check approximately.
    expect(vec[0]).toBeCloseTo(0.7, 5);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    // Slept ~1.5s + 500ms buffer = 2000ms.
    expect(sleepImpl.mock.calls[0]?.[0]).toBe(2000);
  });

  it('throws actionable error on non-cold-start failures (e.g. 401)', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
        json: () => Promise.resolve({ error: 'Unauthorized' }),
      }),
    );
    const factory = makeHfInferenceFactory({ apiKey: 'hf_bad', fetchImpl });
    const client = new EmbedClient(factory);

    await expect(client.encode('hi')).rejects.toThrow(/401.*Unauthorized/);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no retry on 401
  });

  it('throws when API returns a wrong-dim vector', async () => {
    const fetchImpl = fakeOkFetch([new Array<number>(100).fill(0)]);
    const factory = makeHfInferenceFactory({ apiKey: 'hf_test', fetchImpl });
    const client = new EmbedClient(factory);

    await expect(client.encode('hi')).rejects.toThrow(/100-d, expected 384-d/);
  });

  it('throws when API returns a wrong number of vectors for a batch', async () => {
    const fetchImpl = fakeOkFetch([vec384(0)]); // 1 vector for 3 inputs
    const factory = makeHfInferenceFactory({ apiKey: 'hf_test', fetchImpl });
    const client = new EmbedClient(factory);

    await expect(client.encodeBatch(['a', 'b', 'c'])).rejects.toThrow(
      /returned 1 vectors for 3 inputs/,
    );
  });

  it('throws on non-array response shape', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{}'),
        json: () => Promise.resolve({ unexpected: true }),
      }),
    );
    const factory = makeHfInferenceFactory({ apiKey: 'hf_test', fetchImpl });
    const client = new EmbedClient(factory);

    await expect(client.encode('hi')).rejects.toThrow(/expected array response/);
  });

  it('throws when cold-start retry also fails', async () => {
    const cold = {
      ok: false,
      status: 503,
      text: () =>
        Promise.resolve(
          JSON.stringify({ error: 'Model is currently loading', estimated_time: 0.1 }),
        ),
      json: () =>
        Promise.resolve({ error: 'Model is currently loading', estimated_time: 0.1 }),
    };
    const stillCold = {
      ok: false,
      status: 503,
      text: () => Promise.resolve('still cold'),
      json: () => Promise.resolve({}),
    };
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(cold)
      .mockResolvedValueOnce(stillCold);
    const sleepImpl = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    const factory = makeHfInferenceFactory({ apiKey: 'hf_test', fetchImpl, sleepImpl });
    const client = new EmbedClient(factory);

    await expect(client.encode('hi')).rejects.toThrow(/cold-start retry failed.*503/);
  });

  it('does NOT retry on 503 without estimated_time (treated as fatal)', async () => {
    const fatal503 = {
      ok: false,
      status: 503,
      text: () => Promise.resolve('Service Unavailable'),
      json: () => Promise.resolve({ error: 'Service Unavailable' }),
    };
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(fatal503);
    const sleepImpl = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    const factory = makeHfInferenceFactory({ apiKey: 'hf_test', fetchImpl, sleepImpl });
    const client = new EmbedClient(factory);

    await expect(client.encode('hi')).rejects.toThrow(/503.*Service Unavailable/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });
});
