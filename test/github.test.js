import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { GitHubClient, RateLimitError, GitHubApiError, nextLink } from '../src/github.js';

/** A minimal fetch response double. */
const res = (status, body, headers = {}) => {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status < 400,
    json: async () => body,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
  };
};

/** A fetch double that replays a scripted queue of responses (last one repeats). */
const scripted = (...responses) => {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url: url instanceof URL ? url : new URL(url), headers: init?.headers ?? {} });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    return r;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
};

describe('nextLink (RFC-5988)', () => {
  test('extracts the rel="next" URL from a multi-segment header', () => {
    const link = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"';
    assert.equal(nextLink(link), 'https://api.github.com/x?page=2');
  });
  test('returns null without a next segment', () => {
    assert.equal(nextLink('<https://api.github.com/x?page=5>; rel="last"'), null);
    assert.equal(nextLink(null), null);
    assert.equal(nextLink(''), null);
  });
});

describe('GitHubClient.getUser', () => {
  test('parses a profile', async () => {
    const f = scripted(res(200, { login: 'demodev', id: 42 }, { 'x-ratelimit-remaining': '59' }));
    const c = new GitHubClient({ baseUrl: 'https://api.github.com', fetchImpl: f });
    const u = await c.getUser('demodev');
    assert.equal(u.login, 'demodev');
    assert.equal(f.calls[0].url.pathname, '/users/demodev');
    assert.equal(c.rateLimit.remaining, 59);
  });

  test('404 maps to null', async () => {
    const c = new GitHubClient({ fetchImpl: scripted(res(404, { message: 'Not Found' })) });
    assert.equal(await c.getUser('ghost'), null);
  });

  test('403 with exhausted limit raises RateLimitError with reset time', async () => {
    const f = scripted(res(403, { message: 'rate limit exceeded' }, {
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1792897137',
    }));
    const c = new GitHubClient({ fetchImpl: f });
    await assert.rejects(() => c.getUser('demodev'), (err) => {
      assert.ok(err instanceof RateLimitError);
      assert.equal(err.resetAt, new Date(1792897137 * 1000).toISOString());
      return true;
    });
  });

  test('403 with remaining budget is a plain API error (not rate limit)', async () => {
    const c = new GitHubClient({
      fetchImpl: scripted(res(403, { message: 'forbidden' }, { 'x-ratelimit-remaining': '48' })),
    });
    await assert.rejects(() => c.getUser('demodev'), (err) => {
      assert.ok(err instanceof GitHubApiError);
      assert.ok(!(err instanceof RateLimitError));
      assert.equal(err.status, 403);
      return true;
    });
  });

  test('5xx raises GitHubApiError with status and url', async () => {
    const c = new GitHubClient({ fetchImpl: scripted(res(500, { message: 'oops' })) });
    await assert.rejects(() => c.getUser('demodev'), (err) => {
      assert.equal(err.status, 500);
      assert.match(err.message, /500/);
      return true;
    });
  });

  test('network failure is wrapped', async () => {
    const c = new GitHubClient({
      fetchImpl: async () => { const e = new Error('ECONNREFUSED'); throw e; },
    });
    await assert.rejects(() => c.getUser('demodev'), (err) => {
      assert.ok(err instanceof GitHubApiError);
      assert.match(err.message, /network failure/);
      return true;
    });
  });

  test('token is sent as a Bearer header when configured', async () => {
    const f = scripted(res(200, { login: 'demodev' }));
    const c = new GitHubClient({ token: 'ghp_secret', fetchImpl: f });
    await c.getUser('demodev');
    assert.equal(f.calls[0].headers.Authorization, 'Bearer ghp_secret');
    assert.equal(f.calls[0].headers['User-Agent'], 'dev-agent-memory');
  });
});

describe('pagination', () => {
  const page = (items, nextUrl) => res(200, items, nextUrl ? { link: `<${nextUrl}>; rel="next"` } : {});

  test('follows Link rel="next" until it ends', async () => {
    const f = scripted(
      page([{ id: 1 }, { id: 2 }], 'https://api.github.com/users/demodev/repos?page=2'),
      page([{ id: 3 }]),
    );
    const c = new GitHubClient({ fetchImpl: f });
    const items = [];
    for await (const r of c.listUserRepos('demodev')) items.push(r);
    assert.equal(items.length, 3);
    // first request carries per_page + sort/type, the follower carries none
    assert.equal(f.calls[0].url.searchParams.get('per_page'), '100');
    assert.equal(f.calls[0].url.searchParams.get('sort'), 'pushed');
    assert.equal(f.calls[0].url.searchParams.get('type'), 'owner');
    assert.equal(f.calls[1].url.searchParams.get('page'), '2');
    assert.equal(f.calls[1].url.searchParams.get('per_page'), null);
  });

  test('stops at maxPages even if the server keeps paginating', async () => {
    const f = scripted(page([{ id: 1 }], 'https://api.github.com/users/demodev/repos?page=2'));
    const c = new GitHubClient({ maxPages: 2, fetchImpl: f });
    const items = [];
    for await (const r of c.listUserRepos('demodev')) items.push(r);
    assert.equal(items.length, 2);
    assert.equal(f.calls.length, 2);
  });

  test('a 404 page terminates the generator with what was collected', async () => {
    const f = scripted(
      page([{ id: 1 }], 'https://api.github.com/users/demodev/repos?page=2'),
      res(404, {}),
    );
    const c = new GitHubClient({ fetchImpl: f });
    const items = [];
    for await (const r of c.listUserRepos('demodev')) items.push(r);
    assert.equal(items.length, 1);
  });

  test('non-array payload is yielded once', async () => {
    const f = scripted(res(200, { Rust: 41000, Shell: 900 }));
    const c = new GitHubClient({ fetchImpl: f });
    const langs = await c.listRepoLanguages('demodev', 'rust-queue');
    assert.equal(langs.Rust, 41000);
    assert.equal(f.calls[0].url.pathname, '/repos/demodev/rust-queue/languages');
  });
});
