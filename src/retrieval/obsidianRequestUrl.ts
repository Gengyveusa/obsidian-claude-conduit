import type { FetchLike } from './HfInferenceFactory';

/**
 * Subset of Obsidian's `requestUrl()` we depend on. Typed structurally
 * so the test suite can pass a plain function without pulling in the
 * `obsidian` package (which ships only `.d.ts`, no runtime entry).
 *
 * Aligned with Obsidian's actual `RequestUrlParam` shape — all input
 * fields are optional in Obsidian's contract, but our adapters always
 * pass them, so we type them as required for clarity.
 */
export interface RequestUrlLike {
  (params: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    throw: boolean;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    text: string;
    json: unknown;
  }>;
}

/**
 * Adapt Obsidian's `requestUrl()` to the minimal `FetchLike` shape that
 * `HfInferenceFactory`'s v0.2.1–v0.2.4 hand-rolled HTTP code consumed.
 *
 * Why this exists: HuggingFace's Inference API does not return
 * `Access-Control-Allow-Origin` for the `app://obsidian.md` origin, so
 * `globalThis.fetch()` from the renderer is blocked by CORS preflight.
 * `requestUrl()` runs in Electron's main process and bypasses renderer
 * CORS entirely.
 *
 * Retained alongside `makeObsidianRequestUrlNativeFetch` because some
 * call sites still use the minimal `FetchLike` contract.
 *
 * @example
 *   import { requestUrl } from 'obsidian';
 *   const factory = makeHfInferenceFactory({
 *     apiKey: settings.huggingfaceApiKey,
 *     fetchImpl: makeObsidianRequestUrlFetch(requestUrl),
 *   });
 */
export function makeObsidianRequestUrlFetch(requestUrl: RequestUrlLike): FetchLike {
  return async (url, init) => {
    const res = await requestUrl({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
      throw: false,
    });
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      text: () => Promise.resolve(res.text),
      json: () => Promise.resolve(res.json),
    };
  };
}

/**
 * Native `typeof fetch` adapter wrapping Obsidian's `requestUrl()` —
 * returns real `Response` objects so the `@huggingface/inference` SDK
 * (which uses `.json()`, `.text()`, `.headers.get()`, `.ok`, `.status`)
 * works against our CORS-free transport.
 *
 * Used by `HfInferenceFactory` from v0.2.5 onward (per ADR-013
 * postscript #3 — bundle the SDK to insulate from URL evolution).
 *
 * @example
 *   import { requestUrl } from 'obsidian';
 *   const client = new InferenceClient(token, {
 *     fetch: makeObsidianRequestUrlNativeFetch(requestUrl),
 *   });
 */
export function makeObsidianRequestUrlNativeFetch(requestUrl: RequestUrlLike): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method ?? 'GET';

    // Normalize headers to Record<string, string>. fetch() accepts Headers,
    // array-of-tuples, or plain objects; requestUrl() wants a flat object.
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw) {
      if (raw instanceof Headers) {
        raw.forEach((v, k) => {
          headers[k] = v;
        });
      } else if (Array.isArray(raw)) {
        for (const [k, v] of raw) {
          headers[k] = v;
        }
      } else {
        Object.assign(headers, raw);
      }
    }

    // requestUrl() accepts string or ArrayBuffer body. The SDK only sends
    // JSON-serialized strings for feature-extraction; throw on anything
    // else so a future SDK change (e.g. binary uploads) surfaces loudly
    // instead of silently sending "[object Object]".
    let body = '';
    if (typeof init?.body === 'string') {
      body = init.body;
    } else if (init?.body != null) {
      throw new Error(
        `makeObsidianRequestUrlNativeFetch: non-string body type "${typeof init.body}" — ` +
          `the SDK only sends JSON strings for feature-extraction; this code path needs updating.`,
      );
    }

    const res = await requestUrl({ url, method, headers, body, throw: false });

    const responseHeaders = new Headers();
    for (const [k, v] of Object.entries(res.headers)) {
      responseHeaders.set(k, v);
    }

    return new Response(res.text, {
      status: res.status,
      headers: responseHeaders,
    });
  };
}
