import type { EmbedPipeline, EmbedPipelineFactory } from './EmbedClient';
import { VECTOR_DIM } from './SqliteEngine';

/**
 * Embedding contract §1 model name. HF Inference (routed via the
 * `router.huggingface.co` "Inference Providers" gateway) hosts this
 * exact model — output is bit-compatible (within FP rounding) with the
 * local sentence-transformers/all-MiniLM-L6-v2 that corpus-ingest uses.
 *
 * The legacy `api-inference.huggingface.co/models/{id}` endpoint was
 * retired (returns 404 `Cannot POST /models/...`); v0.2.2 switched to
 * the router URL pattern. See ADR-013 postscript #2.
 */
const HF_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';
const HF_ENDPOINT = `https://router.huggingface.co/hf-inference/models/${HF_MODEL}/pipeline/feature-extraction`;

/** Max wait we'll honor on a cold-start retry, regardless of HF's hint. */
const MAX_COLD_START_WAIT_MS = 60_000;

/** Minimal subset of `fetch` we depend on — lets tests inject a mock. */
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
  /** Inject a fake fetch in tests. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /**
   * Sleep helper used during cold-start retry. Tests inject a no-op
   * to keep the suite fast.
   */
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Build an EmbedPipelineFactory backed by HuggingFace's hosted Inference
 * API per ADR-013. Returns an `EmbedPipeline` whose call signature
 * matches the existing transformers.js contract — drop-in replacement
 * for the old defaultFactory in EmbedClient.ts.
 *
 * Failure modes (all surfaced as actionable errors per spec §8):
 *   - Empty `apiKey` → throws at factory call, before any network I/O.
 *   - HF 503 with `estimated_time` → wait that many seconds + retry once.
 *   - HF 429 / 5xx other than the cold-start case → throw with status
 *     and response body so the caller can show it.
 *   - Wrong-shape response → throw; transformers.js' surface guarantees
 *     a 384-d Float32Array per input.
 *
 * @example
 *   const factory = makeHfInferenceFactory({ apiKey: settings.huggingfaceApiKey });
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

    // The `as FetchLike` cast is redundant in strict TS but eslint with
    // type-check info insists on it being typed; assign with annotation.
    const fetchImpl: FetchLike = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const sleepImpl = opts.sleepImpl ?? defaultSleep;
    const model = opts.model ?? HF_MODEL;
    const endpoint = `https://router.huggingface.co/hf-inference/models/${model}/pipeline/feature-extraction`;

    const pipeline: EmbedPipeline = async (text) => {
      const inputs = Array.isArray(text) ? text : [text];
      // NFC normalize at the boundary so cold and warm callers produce
      // identical bytes regardless of Unicode form.
      const normalized = inputs.map((t) => t.normalize('NFC'));

      const vectors = await callWithColdStartRetry(
        fetchImpl,
        sleepImpl,
        endpoint,
        opts.apiKey,
        normalized,
      );

      // Flatten into a single Float32Array of length (n × VECTOR_DIM)
      // so the existing EmbedPipeline contract returns one buffer.
      if (vectors.length !== inputs.length) {
        throw new Error(
          `HfInferenceFactory: API returned ${vectors.length} vectors for ${inputs.length} inputs.`,
        );
      }
      const flat = new Float32Array(vectors.length * VECTOR_DIM);
      for (let i = 0; i < vectors.length; i++) {
        const v = vectors[i];
        if (v.length !== VECTOR_DIM) {
          throw new Error(
            `HfInferenceFactory: vector ${i} is ${v.length}-d, expected ${VECTOR_DIM}-d. ` +
              `Wrong model? Endpoint: ${endpoint}.`,
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
 * Single POST to the HF Inference API, retrying once if the response is
 * a cold-start 503 with an `estimated_time` hint.
 */
async function callWithColdStartRetry(
  fetchImpl: FetchLike,
  sleepImpl: (ms: number) => Promise<void>,
  endpoint: string,
  apiKey: string,
  inputs: string[],
): Promise<number[][]> {
  const body = JSON.stringify({ inputs });
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const first = await fetchImpl(endpoint, { method: 'POST', headers, body });
  if (first.ok) {
    return parseVectors(await first.json());
  }

  // Cold-start path: HF returns 503 with { error, estimated_time } when
  // the model is being loaded onto an inference instance.
  if (first.status === 503) {
    const text = await first.text();
    let parsed: { estimated_time?: unknown; error?: unknown } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      // Non-JSON 503 — treat as fatal.
    }
    const hint = typeof parsed.estimated_time === 'number' ? parsed.estimated_time : null;
    if (hint !== null) {
      const waitMs = Math.min(Math.ceil(hint * 1000) + 500, MAX_COLD_START_WAIT_MS);
      await sleepImpl(waitMs);
      const second = await fetchImpl(endpoint, { method: 'POST', headers, body });
      if (second.ok) {
        return parseVectors(await second.json());
      }
      throw new Error(
        `HfInferenceFactory: cold-start retry failed (${second.status}): ${await second.text()}`,
      );
    }
  }

  throw new Error(
    `HfInferenceFactory: ${first.status} from ${endpoint}: ${await first.text()}`,
  );
}

function parseVectors(raw: unknown): number[][] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `HfInferenceFactory: expected array response, got ${typeof raw}: ${JSON.stringify(raw).slice(0, 120)}`,
    );
  }
  const out: number[][] = [];
  for (const row of raw) {
    if (!Array.isArray(row)) {
      throw new Error(
        `HfInferenceFactory: expected row to be an array of numbers, got ${typeof row}.`,
      );
    }
    out.push(row as number[]);
  }
  return out;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { HF_MODEL, HF_ENDPOINT, MAX_COLD_START_WAIT_MS };
