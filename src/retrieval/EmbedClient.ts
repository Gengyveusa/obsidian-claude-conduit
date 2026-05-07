import { VECTOR_DIM } from './SqliteEngine';

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';

/**
 * Minimal pipeline shape. transformers.js's actual return type is
 * elaborate (a `FeatureExtractionPipeline` with overloads); we only need
 * the call signature + the `.data` Float32Array on the result.
 */
export interface EmbedPipeline {
  (
    text: string | string[],
    opts?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean },
  ): Promise<{ data: Float32Array; dims?: number[] }>;
}

/**
 * Factory that produces an EmbedPipeline. Default implementation
 * dynamic-imports `@xenova/transformers` so its ~3 MB of code + ONNX
 * runtime never runs on plugin load — only when `encode()` is first
 * called. Tests inject a deterministic stub.
 */
export type EmbedPipelineFactory = () => Promise<EmbedPipeline>;

const defaultFactory: EmbedPipelineFactory = async () => {
  // Dynamic import keeps transformers.js out of the synchronous main.js
  // load path. esbuild still bundles it (CJS output), but parse-evaluation
  // is deferred to first call.
  // FFI boundary: transformers.js typings are too elaborate to retype here.
  // TODO: type — narrow once @xenova/transformers ships stable .d.ts.
  const transformers = (await import('@xenova/transformers')) as unknown as {
    pipeline: (task: string, model: string) => Promise<EmbedPipeline>;
    env: {
      allowLocalModels: boolean;
      allowRemoteModels: boolean;
      useBrowserCache: boolean;
      useFSCache: boolean;
      cacheDir?: string;
      localModelPath?: string;
    };
  };

  // Force the browser/web path. In Obsidian's Electron renderer, Node's
  // `fs` and `path` modules ARE available, so transformers.js's env
  // detection thinks we're "running locally" and tries to construct a
  // local cache directory via path.join(env.cacheDir, ...) — but
  // cacheDir ends up undefined in this environment, throwing
  // "The 'path' argument must be of type string... Received undefined"
  // on every encode call. Forcing browser cache + remote-only models
  // routes through fetch() instead, sidestepping the path issue.
  transformers.env.allowLocalModels = false;
  transformers.env.allowRemoteModels = true;
  transformers.env.useBrowserCache = true;
  transformers.env.useFSCache = false;

  return transformers.pipeline('feature-extraction', MODEL_NAME);
};

/**
 * Wraps `@xenova/transformers`' feature-extraction pipeline for the
 * canonical `all-MiniLM-L6-v2` model (per the embedding contract §1).
 * NFC-normalizes input per §2 so byte-identical inputs always produce
 * byte-identical vectors regardless of Unicode encoding form.
 *
 * @example
 *   const client = new EmbedClient();
 *   const vec = await client.encode('Hello, vault.');  // 384-d Float32Array
 */
export class EmbedClient {
  private pipelinePromise: Promise<EmbedPipeline> | null = null;

  constructor(private readonly factory: EmbedPipelineFactory = defaultFactory) {}

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
          `Wrong model loaded? Expected ${MODEL_NAME}.`,
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
