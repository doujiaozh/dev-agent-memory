// Minimal GitHub REST API client.
//
// Design notes:
//  - GITHUB_TOKEN is optional (unauthenticated core limit is 60 req/h, which is
//    enough for one sync of ~3 requests; a token lifts it to 5000/h).
//  - The base URL can be overridden (GITHUB_API_BASE / --api) so tests can run
//    against a local mock server offline.
//  - Pagination follows the RFC-5988 Link header, capped by maxPages.

const DEFAULT_BASE = 'https://api.github.com';

export class RateLimitError extends Error {
  constructor(message, resetAt) {
    super(message);
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
  }
}

export class GitHubApiError extends Error {
  constructor(message, status, url) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.url = url;
  }
}

export function defaultBaseUrl() {
  return (process.env.GITHUB_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
}

export function defaultToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

export class GitHubClient {
  constructor({
    baseUrl = defaultBaseUrl(),
    token = defaultToken(),
    perPage = 100,
    maxPages = 10,
    timeoutMs = 20000,
    fetchImpl = fetch,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token || null;
    this.perPage = perPage;
    this.maxPages = maxPages;
    this.timeoutMs = timeoutMs;
    this._fetch = fetchImpl;
    this.rateLimit = { limit: null, remaining: null, reset: null };
  }

  async _get(path, params = {}) {
    const url = new URL(path, this.baseUrl + '/');
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    const headers = {
      'User-Agent': 'dev-agent-memory',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    let res;
    try {
      res = await this._fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw new GitHubApiError(`request timed out after ${this.timeoutMs}ms: ${url}`, null, url);
      }
      throw new GitHubApiError(`network failure for ${url}: ${e.message}`, null, url);
    }

    this.rateLimit = {
      limit: numOrNull(res.headers.get('X-RateLimit-Limit')),
      remaining: numOrNull(res.headers.get('X-RateLimit-Remaining')),
      reset: numOrNull(res.headers.get('X-RateLimit-Reset')),
    };

    if (res.status === 404) return null;
    if (res.status === 403 && this.rateLimit.remaining === 0) {
      const resetAt = this.rateLimit.reset
        ? new Date(this.rateLimit.reset * 1000).toISOString()
        : 'unknown';
      throw new RateLimitError(
        `GitHub API rate limit exhausted for ${url.hostname}; resets at ${resetAt}. ` +
          'Set GITHUB_TOKEN to lift the limit.', resetAt);
    }
    if (!res.ok) {
      let detail = '';
      try { detail = JSON.stringify(await res.json()).slice(0, 300); } catch { /* ignore */ }
      throw new GitHubApiError(`GitHub API ${res.status} for ${url} ${detail}`.trim(), res.status, url);
    }

    const link = res.headers.get('Link') || res.headers.get('link');
    return { data: await res.json(), next: nextLink(link) };
  }

  /** Fetch a single document; returns null on 404. */
  async getJson(path, params) {
    const page = await this._get(path, params);
    return page ? page.data : null;
  }

  /** Async generator over every page of a list endpoint. */
  async *list(path, params = {}) {
    let url = path;
    let page = 0;
    while (url && page < this.maxPages) {
      const res = await this._get(url, page === 0 ? { per_page: this.perPage, ...params } : {});
      if (!res) return;
      if (Array.isArray(res.data)) {
        for (const item of res.data) yield item;
      } else {
        yield res.data; // non-list payload: single shot
        return;
      }
      url = res.next;
      page += 1;
    }
  }

  // ---- domain helpers ------------------------------------------------------

  getUser(login) { return this.getJson(`/users/${encodeURIComponent(login)}`); }

  listUserRepos(login, { sort = 'pushed' } = {}) {
    return this.list(`/users/${encodeURIComponent(login)}/repos`, { sort, type: 'owner' });
  }

  listPublicEvents(login) {
    return this.list(`/users/${encodeURIComponent(login)}/events/public`);
  }

  listRepoLanguages(owner, repo) {
    return this.getJson(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/languages`);
  }
}

function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Extract the rel="next" URL from a Link header. */
export function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/i);
    if (m) return m[1];
  }
  return null;
}
