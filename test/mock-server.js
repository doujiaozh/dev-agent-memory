// Local stand-in for api.github.com, backed by deterministic fixtures.
// Used by e2e tests and `pnpm demo:offline`. Serves:
//   GET /users/:login
//   GET /users/:login/repos?per_page=&sort=&type=
//   GET /users/:login/events/public?per_page=
//   GET /repos/:full_name/languages
//   GET /rate_limit
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { PROFILE, REPOS, EVENTS, LANGUAGES, RATE_LIMIT } from './fixtures/github.js';

const json = (res, body, status = 200, headers = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4987',
    'x-ratelimit-reset': '1792897137',
    ...headers,
  });
  res.end(payload);
};

export function startServer({ rateLimitRemaining = 4987 } = {}) {
  const seen = { repos: 0, events: 0 };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '');
    const perPage = Number(url.searchParams.get('per_page')) || 30;

    if (path === '/rate_limit') {
      return json(res, RATE_LIMIT, 200, { 'x-ratelimit-remaining': String(rateLimitRemaining) });
    }

    const userMatch = path.match(/^\/users\/([^/]+)$/);
    if (userMatch) {
      const login = userMatch[1];
      if (login === PROFILE.login) return json(res, PROFILE);
      return json(res, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' }, 404);
    }

    if (path === `/users/${PROFILE.login}/repos`) {
      seen.repos += 1;
      const page = Number(url.searchParams.get('page')) || 1;
      const slice = REPOS.slice((page - 1) * perPage, page * perPage);
      const link = REPOS.length > page * perPage
        ? `<http://127.0.0.1:${server.address().port}/users/${PROFILE.login}/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`
        : null;
      return json(res, slice, 200, link ? { link } : {});
    }

    if (path === `/users/${PROFILE.login}/events/public`) {
      seen.events += 1;
      const page = Number(url.searchParams.get('page')) || 1;
      const slice = EVENTS.slice((page - 1) * perPage, page * perPage);
      return json(res, slice);
    }

    const langMatch = path.match(/^\/repos\/([^/]+\/[^/]+)\/languages$/);
    if (langMatch) {
      const langs = LANGUAGES[langMatch[1]];
      if (langs) return json(res, langs);
      return json(res, { message: 'Not Found' }, 404);
    }

    return json(res, { message: 'Not Found' }, 404);
  });

  return new Promise((resolve) => {
    const srv = server.listen(0, '127.0.0.1', () => {
      resolve({
        port: srv.address().port,
        close: () => new Promise((r) => srv.close(() => r())),
        get baseUrl() { return `http://127.0.0.1:${srv.address().port}`; },
        seen,
      });
    });
  });
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  startServer().then(({ port, baseUrl }) => {
    console.log(`mock github api listening at ${baseUrl}`);
    console.log(`fixtures: ${REPOS.length} repos, ${EVENTS.length} events for ${PROFILE.login}`);
    console.log('rate_limit check:', `${baseUrl}/rate_limit`);
  });
}
