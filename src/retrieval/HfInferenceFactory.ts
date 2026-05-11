import { InferenceClient } from '@huggingface/inference';

import type { EmbedPipeline, EmbedPipelineFactory } from './EmbedClient';
import { VECTOR_DIM } from './SqliteEngine';

/**
 * Embedding contract §1 model. HF Inference Providers (the `hf-inference`
 * provider routed via `router.huggingface.co`) hosts this exact model —
 * output is bit-compatible (within FP rounding) with the local
 * sentence-transformers/all-MiniLM-L6-v2 that corpus-ingest uses.
 *
 * The full endpoint URL is now the SDK's concern, not ours — see
 * ADR-013 postscript #3 (v0.2.5: bundle the SDK).
 */
const HF_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';

/**
 * Tests inject a stub instead of pulling in the real SDK. Production wires
 * the real `InferenceClient` from `@huggingface/inference`.
 */
export interface InferenceClientLike {
  /**
   * Declared as a function property (not a method) so call-site assertions
   * via `expect(client.featureExtraction).toHaveBeenCalled()` don't trip
   * `@typescript-eslint/unbound-method` — `this` isn't part of the contract
   * for our stub-injected clients.
   */
  featureExtraction: (args: {
    model?: string;
    inputs: string | string[];
    provider?: 'hf-inference';
  }) => Promise<(number | number[] | number[][])[]>;
}

/**
 * Minimal subset of `fetch` we still expose for legacy tests that exercise
 * the old hand-rolled HTTP code path. Kept for the `obsidianRequestUrl`
 * adapter's `makeObsidianRequestUrlFetch` companion, which keeps working
 * even after v0.2.5 swaps to the SDK.
 */
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

export interface HfFactoryOptions {
  /** HuggingFace read token (e.g. `hf_...`). */
  apiKey: string;
  /** Override the model id. Defaults to the canonical contract model. */
  model?: string;
  /**
   * Custom `fetch` used by the SDK. Production passes a `requestUrl()`-
   * backed adapter from `obsidianRequestUrl.ts` to dodge renderer CORS
   * preflight on `app://obsidian.md`.
   */
  fetch?: typeof fetch;
  /**
   * Test-only: inject a pre-built client so tests don't need to mock the
   * SDK's `fetch` plumbing. Production constructs the real client.
   */
  client?: InferenceClientLike;
}

/**
 * Build an `EmbedPipelineFactory` backed by HuggingFace's official
 * `@huggingface/inference` SDK. Replaces v0.2.1–v0.2.4's hand-rolled
 * fetch + URL constants — the SDK now owns URL evolution, provider
 * routing, and retry behavior. We just feed it our CORS-free transport
 * and unflatten its response.
 *
 * Failure modes (all surfaced as actionable errors per spec §8):
 *   - Empty `apiKey` → throws at factory call, before any network I/O.
 *   - SDK throws (network, 401, 503, etc.) → re-throw with context.
 *   - Wrong-shape response → throw with the unexpected shape so the
 *     caller can show it. Contract guarantees a 384-d Float32Array per
 *     input.
 *
 * @example
 *   import { requestUrl } from 'obsidian';
 *   const factory = makeHfInferenceFactory({
 *     apiKey: settings.huggingfaceApiKey,
 *     fetch: makeObsidianRequestUrlNativeFetch(requestUrl),
 *   });
 *   const client = new EmbedClient(factory);
 *   const vec = await client.encode('Hello, vault.');
 */
export function makeHfInferenceFactory(opts: HfFactoryOptions): EmbedPipelineFactory {
  return () => {
    if (opts.apiKey.length === 0) {
      throw new Error(
        'HfInferenceFactory: huggingfaceApiKey is empty. ' +
          'Get a free read token at https://huggingface.co/settings/tokens ' +
          'and paste it into Settings → Sagittarius → HuggingFace API key.',
      );
    }

    const model = opts.model ?? HF_MODEL;
    const client: InferenceClientLike =
      opts.client ??
      new InferenceClient(opts.apiKey, opts.fetch ? { fetch: opts.fetch } : undefined);

    const pipeline: EmbedPipeline = async (text) => {
      const inputs = Array.isArray(text) ? text : [text];
      // NFC normalize at the boundary so cold and warm callers produce
      // identical bytes regardless of Unicode form.
      const normalized = inputs.map((t) => t.normalize('NFC'));

      let raw: (number | number[] | number[][])[];
      try {
        raw = await client.featureExtraction({
          model,
          inputs: normalized,
          provider: 'hf-inference',
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `HfInferenceFactory: SDK featureExtraction failed for model "${model}": ${msg}`,
        );
      }

      const vectors = normalizeVectors(raw, inputs.length);

      const flat = new Float32Array(vectors.length * VECTOR_DIM);
      for (let i = 0; i < vectors.length; i++) {
        const v = vectors[i];
        if (v.length !== VECTOR_DIM) {
          throw new Error(
            `HfInferenceFactory: vector ${i} is ${v.length}-d, expected ${VECTOR_DIM}-d. ` +
              `Wrong model? model="${model}".`,
          );
        }
        for (let j = 0; j < VECTOR_DIM; j++) {
          flat[i * VECTOR_DIM + j] = v[j];
        }
      }

      return { data: flat };
    };

    return Promise.resolve(pipeline);
  };
}

/**
 * The SDK's return type is `(number | number[] | number[][])[]` — a union
 * shaped by how feature-extraction servers vary across providers (some
 * pool, some don't). For sentence-transformers/all-MiniLM-L6-v2 with the
 * `hf-inference` provider we expect `number[][]` (one 384-d vector per
 * input) but we accept `number[]` for the single-input case and a few
 * other reasonable shapes.
 */
function normalizeVectors(
  raw: (number | number[] | number[][])[],
  expectedCount: number,
): number[][] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `HfInferenceFactory: expected array response, got ${typeof raw}: ${JSON.stringify(raw).slice(0, 120)}`,
    );
  }

  // Single-input shortcut: if expectedCount === 1 and raw is number[],
  // treat it as one row.
  if (expectedCount === 1 && raw.length > 0 && typeof raw[0] === 'number') {
    return [raw as number[]];
  }

  // Standard shape: number[][] — one row per input.
  if (raw.length === expectedCount && raw.every((r) => Array.isArray(r) && typeof r[0] === 'number')) {
    return raw as number[][];
  }

  // Single nested array (e.g. some providers return [[v1,v2,...]] for one input).
  if (expectedCount === 1 && raw.length === 1 && Array.isArray(raw[0])) {
    const first = raw[0];
    if (typeof first[0] === 'number') {
      return [first as number[]];
    }
  }

  throw new Error(
    `HfInferenceFactory: API returned ${raw.length} rows for ${expectedCount} inputs ` +
      `(unexpected shape: ${JSON.stringify(raw).slice(0, 120)})`,
  );
}

export { HF_MODEL };
