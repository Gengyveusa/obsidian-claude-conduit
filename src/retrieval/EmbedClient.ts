import { VECTOR_DIM } from './SqliteEngine';

/**
 * Minimal pipeline shape — the call signature + a `.data` Float32Array
 * on the result. The shape originated in the transformers.js era
 * (ADR-012 deferred that) and is now satisfied by `HfInferenceFactory`'s
 * SDK-backed pipeline. Kept narrow so future factories can plug in
 * without dragging the SDK into tests.
 */
export interface EmbedPipeline {
  (
    text: string | string[],
    opts?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean },
  ): Promise<{ data: Float32Array; dims?: number[] }>;
}

/**
 * Factory that produces an EmbedPipeline. Tests inject a deterministic
 * stub; production wires `makeHfInferenceFactory` per ADR-013 (v0.2)
 * or another factory in later phases. There is no default — callers
 * must inject one — so esbuild never traces a transformers.js fallback
 * into the bundle (ADR-012 deferred that path; pulling its symbol here
 * was bloating main.js to 2 MB even when unused).
 */
export type EmbedPipelineFactory = () => Promise<EmbedPipeline>;

/**
 * Wraps an `EmbedPipelineFactory` (production: `makeHfInferenceFactory`
 * backed by `@huggingface/inference` SDK) for the canonical
 * `all-MiniLM-L6-v2` model per the embedding contract §1. NFC-normalizes
 * input per §2 so byte-identical inputs always produce byte-identical
 * vectors regardless of Unicode encoding form.
 *
 * @example
 *   const factory = makeHfInferenceFactory({ apiKey, fetch });
 *   const client = new EmbedClient(factory);
 *   const vec = await client.encode('Hello, vault.');  // 384-d Float32Array
 */
export class EmbedClient {
  private pipelinePromise: Promise<EmbedPipeline> | null = null;

  constructor(private readonly factory: EmbedPipelineFactory) {}

  /**
   * Encode a single text string to a 384-d normalized embedding.
   * Mean-pooled and L2-normalized (cosine sim = dot product).
   * @example const vec = await client.encode('Hello, vault.');
   */
  async encode(text: string): Promise<Float32Array> {
    const pipeline = await this.getPipeline();
    const normalized = text.normalize('NFC');
    const result = await pipeline(normalized, { pooling: 'mean', normalize: true });
    if (result.data.length !== VECTOR_DIM) {
      throw new Error(
        `EmbedClient.encode: pipeline returned ${result.data.length} dims, expected ${VECTOR_DIM}. ` +
          `Wrong model wired into the EmbedPipelineFactory?`,
      );
    }
    return new Float32Array(result.data);
  }

  /**
   * Encode many strings in one batch. Returns vectors in input order.
   * @example const vecs = await client.encodeBatch(['hello', 'world']);
   */
  async encodeBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }
    const pipeline = await this.getPipeline();
    const normalized = texts.map((t) => t.normalize('NFC'));
    const result = await pipeline(normalized, { pooling: 'mean', normalize: true });
    const flat = result.data;
    if (flat.length !== texts.length * VECTOR_DIM) {
      throw new Error(
        `EmbedClient.encodeBatch: pipeline returned ${flat.length} floats, ` +
          `expected ${texts.length * VECTOR_DIM} (${texts.length} × ${VECTOR_DIM}).`,
      );
    }
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      out.push(new Float32Array(flat.subarray(i * VECTOR_DIM, (i + 1) * VECTOR_DIM)));
    }
    return out;
  }

  /** True once the pipeline has been requested (model loading is in flight or done). */
  isLoaded(): boolean {
    return this.pipelinePromise !== null;
  }

  private async getPipeline(): Promise<EmbedPipeline> {
    this.pipelinePromise ??= this.factory();
    return this.pipelinePromise;
  }
}
