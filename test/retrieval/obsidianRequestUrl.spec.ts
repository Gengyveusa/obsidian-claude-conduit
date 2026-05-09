import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeObsidianRequestUrlFetch } from '../../src/retrieval/obsidianRequestUrl';

describe('makeObsidianRequestUrlFetch', () => {
  let requestUrl: ReturnType<typeof vi.fn>;
  let fetchImpl: ReturnType<typeof makeObsidianRequestUrlFetch>;

  beforeEach(() => {
    requestUrl = vi.fn();
    fetchImpl = makeObsidianRequestUrlFetch(requestUrl);
  });

  it('forwards method, headers, body to requestUrl with throw:false', async () => {
    requestUrl.mockResolvedValueOnce({ status: 200, text: '[]', json: [] });

    await fetchImpl('https://example.test/x', {
      method: 'POST',
      headers: { Authorization: 'Bearer hf_test', 'Content-Type': 'application/json' },
      body: '{"inputs":["hi"]}',
    });

    expect(requestUrl).toHaveBeenCalledTimes(1);
    expect(requestUrl).toHaveBeenCalledWith({
      url: 'https://example.test/x',
      method: 'POST',
      headers: { Authorization: 'Bearer hf_test', 'Content-Type': 'application/json' },
      body: '{"inputs":["hi"]}',
      throw: false,
    });
  });

  it('reports ok=true for 2xx and exposes text + json', async () => {
    requestUrl.mockResolvedValueOnce({
      status: 200,
      text: '[[0.1,0.2]]',
      json: [[0.1, 0.2]],
    });

    const res = await fetchImpl('https://h/x', { method: 'POST', headers: {}, body: '' });

    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('[[0.1,0.2]]');
    await expect(res.json()).resolves.toEqual([[0.1, 0.2]]);
  });

  it('reports ok=false for non-2xx but still surfaces status + body', async () => {
    requestUrl.mockResolvedValueOnce({
      status: 503,
      text: '{"error":"loading","estimated_time":12}',
      json: { error: 'loading', estimated_time: 12 },
    });

    const res = await fetchImpl('https://h/x', { method: 'POST', headers: {}, body: '' });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    await expect(res.text()).resolves.toMatch(/estimated_time/);
  });

  it('treats 299 as ok and 300 as not-ok (boundary)', async () => {
    requestUrl.mockResolvedValueOnce({ status: 299, text: '', json: null });
    const a = await fetchImpl('https://h/x', { method: 'GET', headers: {}, body: '' });
    expect(a.ok).toBe(true);

    requestUrl.mockResolvedValueOnce({ status: 300, text: '', json: null });
    const b = await fetchImpl('https://h/x', { method: 'GET', headers: {}, body: '' });
    expect(b.ok).toBe(false);
  });
});
