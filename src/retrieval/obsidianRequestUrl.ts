import type { FetchLike } from './HfInferenceFactory';

/**
 * Subset of Obsidian's `requestUrl()` we depend on. Typed structurally
 * so the test suite can pass a plain function without pulling in the
 * `obsidian` package (which ships only `.d.ts`, no runtime entry).
 */
export interface RequestUrlLike {
  (params: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    throw: boolean;
  }): Promise<{ status: number; text: string; json: unknown }>;
}

/**
 * Adapt Obsidian's `requestUrl()` to the `FetchLike` shape that
 * `HfInferenceFactory` consumes.
 *
 * Why this exists: HuggingFace's Inference API does not return
 * `Access-Control-Allow-Origin` for the `app://obsidian.md` origin, so
 * `globalThis.fetch()` from the renderer is blocked by CORS preflight.
 * `requestUrl()` runs in Electron's main process and bypasses renderer
 * CORS entirely.
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
