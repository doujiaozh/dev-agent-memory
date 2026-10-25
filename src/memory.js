// The memory domain service: sync a GitHub identity into the local graph, then
// query it back (find / route / graph / stats). This is the "AI memory library"
// surface — everything an agent or a human would call.

import * as db from './db.js';
import {
  classifyMessage, cleanCommitMessage, cleanDescription, dayOf, hourOf, normalizeLanguage, squashText,
} from './cleaner.js';
import {
  aggregateUserTags, frequencyBuckets, frequencySummary, repoFeatures, repoTags,
} from './derive.js';
import { GitHubClient } from './github.js';
import { log } from './util.js';

/** Build a safe FTS5 MATCH expression from free user text. */
export function buildMatchExpr(query, { mode = 'or' } = {}) {
  const tokens = String(query)
    .replace(/["*]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2 && /[a-z0-9+#]/.test(t));
  if (!tokens.length) return null;
  const joiner = mode === 'and' ? ' AND ' : ' OR ';
  return tokens.map((t) => `"${t}"*`).join(joiner);
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Fetch + clean + store a GitHub user's profile, repositories and recent public
 * commits, then rebuild the search index. Returns a summary object.
 *
 * @param {object} opts
 * @param {GitHubClient} opts.client  injectable for tests
 * @param {number} opts.repoLimit     cap repositories fetched (default 100)
 * @param {number} opts.commitLimit   cap commits stored (default 500)
 * @param {number} opts.deepLangRepos enrich languages for top-N active repos (default 3, 0 disables)
 */
export async function syncUser(dbHandle, login, opts = {}) {
  const client = opts.client ?? new GitHubClient();
  const {
    repoLimit = 100,
    commitLimit = 500,
    deepLangRepos = 3,
    onProgress = () => {},
  } = opts;
  const lg = (msg) => { log.debug(msg); onProgress(msg); };
  const t0 = Date.now();

  lg(`fetching profile for ${login}`);
  const profile = await client.getUser(login);
  if (!profile) throw new Error(`GitHub user not found: ${login}`);
  const userId = db.upsertUser(dbHandle, profile);

  // ---- repositories --------------------------------------------------------
  lg('fetching repositories');
  const repos = [];
  const repoLangs = new Map(); // full_name -> languagesJson
  for await (const repo of client.listUserRepos(login)) {
    if (repos.length >= repoLimit) break;
    const cleaned = cleanRepoPayload(repo);
    repos.push(cleaned);
  }
  // Optional deep pass: real language byte-maps for the most recently pushed repos.
  const deepTargets = repos
    .filter((r) => !r.fork)
    .slice(0, deepLangRepos);
  for (const repo of deepTargets) {
    try {
      lg(`fetching language mix: ${repo.full_name}`);
      const langs = await client.listRepoLanguages(repo.owner.login, repo.name);
      if (langs && Object.keys(langs).length) repo._languagesJson = JSON.stringify(langs);
    } catch (e) {
      log.warn(`language fetch failed for ${repo.full_name}: ${e.message}`);
    }
  }

  const repoIdByName = new Map();
  for (const repo of repos) {
    const repoId = db.upsertRepo(dbHandle, userId, repo);
    repoIdByName.set(repo.full_name.toLowerCase(), repoId);
    db.setRepoTags(dbHandle, repoId, repoTags(repo));
    db.setCodeFeatures(dbHandle, repoId, repoFeatures(repo));
  }

  // ---- recent commits from public events ------------------------------------
  lg('fetching recent public events');
  const commits = [];
  for await (const event of client.listPublicEvents(login)) {
    if (event.type !== 'PushEvent' || !event.payload?.commits) continue;
    for (const c of event.payload.commits) {
      if (commits.length >= commitLimit) break;
      const { clean, headline } = cleanCommitMessage(c.message);
      if (!clean) continue;
      const repoName = event.repo?.name || null;
      commits.push({
        userId,
        repoId: repoName ? (repoIdByName.get(repoName.toLowerCase()) ?? null) : null,
        repoFullName: repoName,
        sha: c.sha,
        message: clean,
        prefix: classifyMessage(headline || clean),
        authorName: squashText(c.author?.name),
        authorEmail: c.author?.email || null,
        authoredAt: event.created_at,
        day: dayOf(event.created_at),
        hour: hourOf(event.created_at),
        isMerge: /^merge\b/i.test(headline || ''),
      });
    }
    if (commits.length >= commitLimit) break;
  }
  let storedCommits = 0;
  for (const c of commits) if (db.insertCommit(dbHandle, c)) storedCommits += 1;

  // ---- derived aggregates ----------------------------------------------------
  lg('deriving memory facts');
  const hitsPerRepo = new Map();
  for (const c of commits) {
    if (!c.repoFullName) continue;
    hitsPerRepo.set(c.repoFullName, (hitsPerRepo.get(c.repoFullName) || 0) + 1);
  }
  const stored = db.listRepos(dbHandle, userId, { limit: 1000 });
  db.setUserTags(dbHandle, userId, aggregateUserTags(stored, hitsPerRepo));
  const storedCommitsRows = db.listCommits(dbHandle, { userId, limit: 5000 });
  db.setCommitFrequency(dbHandle, userId, frequencyBuckets(storedCommitsRows));

  const indexSize = db.rebuildIndex(dbHandle);
  const summary = {
    user: profile.login,
    repos_synced: repos.length,
    commits_seen: commits.length,
    commits_stored: storedCommits,
    languages_fetched: deepTargets.length,
    index_size: indexSize,
    rate_limit: client.rateLimit,
    elapsed_ms: Date.now() - t0,
  };
  log.debug('sync complete: %o', summary);
  return summary;
}

function cleanRepoPayload(repo) {
  // Normalize the raw API shapes into the storage/derivation shapes:
  //  - license arrives as { spdx_id } (or null), derivation wants a string
  //  - open_issues_count -> open_issues so repoFeatures can read it
  const license = typeof repo.license === 'string'
    ? repo.license
    : (repo.license?.spdx_id || repo.license?.name || null);
  return {
    ...repo,
    description: cleanDescription(repo.description),
    language: normalizeLanguage(repo.language),
    // repoTags reads topics_json (the stored shape), so mirror what upsertRepo stores.
    topics_json: Array.isArray(repo.topics) ? JSON.stringify(repo.topics) : (repo._topicsJson ?? null),
    license: license || null,
    open_issues: repo.open_issues_count ?? repo.open_issues ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Query API
// ---------------------------------------------------------------------------

/**
 * `memory find <query>` — hybrid search:
 *   1. exact/prefix tag hits (the tech-stack vocabulary)
 *   2. FTS5 bm25 ranked matches over users/repos/commits/tags
 *   3. LIKE fallback when neither has any hit
 * Returns grouped, enriched results.
 */
export function find(dbHandle, query, { kind = null, limit = 25 } = {}) {
  const out = { query, tag_hits: [], users: [], repos: [], commits: [], tags: [] };

  // 1) tag vocabulary hits
  const expr = buildMatchExpr(query, { mode: 'and' }) || null;
  const tagRows = db.listTags(dbHandle, { limit: 500 });
  const q = query.trim().toLowerCase();
  for (const t of tagRows) {
    if (t.name === q || t.name.startsWith(q) || t.name.includes(q)) {
      out.tag_hits.push({ name: t.name, kind: t.kind, weight: t.weight, repo_count: t.repo_count });
      if (out.tag_hits.length >= 10) break;
    }
  }

  // 2) full-text matches, bm25 ranked
  if (expr) {
    const rows = db.ftsSearch(dbHandle, expr, { limit: limit * 2 });
    const seenRepo = new Set(), seenUser = new Set(), seenTag = new Set();
    for (const row of rows) {
      if (kind && row.entity_type !== kind) continue;
      if (out.repos.length >= limit && out.commits.length >= limit) break;
      if (row.entity_type === 'repo' && !seenRepo.has(row.entity_id)) {
        seenRepo.add(row.entity_id);
        if (out.repos.length >= limit) continue;
        const repo = db.getRepoById(dbHandle, row.entity_id);
        if (repo) out.repos.push({
          full_name: repo.full_name, description: repo.description,
          language: repo.language, stars: repo.stars,
          activity_tier: db.getCodeFeatures(dbHandle, repo.id)
            .find((f) => f.feature === 'activity_tier')?.value ?? null,
          html_url: repo.html_url, last_pushed_at: repo.last_pushed_at,
        });
      } else if (row.entity_type === 'user' && !seenUser.has(row.entity_id)) {
        seenUser.add(row.entity_id);
        const user = db.getUserById(dbHandle, row.entity_id);
        if (user) out.users.push({
          login: user.login, name: user.name, bio: user.bio,
          public_repos: user.public_repos,
          top_tags: db.listUserTags(dbHandle, user.id, { limit: 5 }).map((t) => t.name),
        });
      } else if (row.entity_type === 'commit') {
        if (out.commits.length >= limit) continue;
        const commit = db.getCommitById(dbHandle, row.entity_id);
        if (commit) out.commits.push({
          sha: commit.sha.slice(0, 10), day: commit.day,
          repo: commit.repo_full_name, message: (commit.message || '').split('\n')[0],
          prefix: commit.message_prefix,
        });
      } else if (row.entity_type === 'tag' && !seenTag.has(row.entity_id)) {
        seenTag.add(row.entity_id);
        const tag = db.getTagById(dbHandle, row.entity_id);
        if (tag) out.tags.push(tag);
      }
    }
  }

  // 3) LIKE fallback — never return an empty memory
  if (!out.repos.length && !out.commits.length && !out.users.length && !out.tags.length && !out.tag_hits.length) {
    const { repos, commits } = db.likeSearch(dbHandle, query, { limit });
    out.repos = repos.map((r) => ({
      full_name: r.full_name, description: r.description, language: r.language,
      stars: r.stars, html_url: r.html_url, last_pushed_at: r.last_pushed_at,
    }));
    out.commits = commits.map((c) => ({
      sha: c.sha.slice(0, 10), day: c.day, repo: c.repo_full_name,
      message: (c.message || '').split('\n')[0], prefix: c.message_prefix,
    }));
    out.fallback = 'like';
  }
  return out;
}

/**
 * `memory route <tag>` — asset routing card: for a technology, which repos own
 * it, how active they are, recent commits there, and the neighborhood of tags.
 */
export function route(dbHandle, tag, { limit = 10 } = {}) {
  const t = tag.trim().toLowerCase();
  const userId = db.listUsers(dbHandle)[0]?.id ?? null;
  const repos = userId ? db.listRepos(dbHandle, userId, { tag: t, limit }) : [];
  const repoIds = repos.map((r) => r.id);
  const commits = repoIds.length
    ? db.listCommits(dbHandle, { userId, limit: 30 }).filter((c) => c.repo_id && repoIds.includes(c.repo_id)).slice(0, limit)
    : [];
  return {
    tag: t,
    related_tags: db.relatedTags(dbHandle, t, { limit: 10 }),
    repos: repos.map((r) => ({
      full_name: r.full_name, description: r.description, language: r.language,
      stars: r.stars, last_pushed_at: r.last_pushed_at, default_branch: r.default_branch,
      features: Object.fromEntries(db.getCodeFeatures(dbHandle, r.id).map((f) => [f.feature, f.value])),
      url: r.html_url,
    })),
    recent_commits: commits.map((c) => ({
      day: c.day, sha: c.sha.slice(0, 10), repo: c.repo_display || c.repo_full_name,
      message: (c.message || '').split('\n')[0],
    })),
  };
}

/** `memory graph <tag>` — the tag neighborhood from the repo-tag bipartite graph. */
export function tagGraph(dbHandle, tag, { limit = 10 } = {}) {
  const t = tag.trim().toLowerCase();
  const rows = db.relatedTags(dbHandle, t, { limit });
  const total = db.listTags(dbHandle, { limit: 500 }).find((x) => x.name === t);
  return {
    tag: t,
    repo_count: total?.repo_count ?? 0,
    weight: total?.weight ?? 0,
    neighbors: rows.map((r) => ({ tag: r.tag, kind: r.kind, shared_repos: r.shared_repos })),
  };
}

/** `memory stats` + user profile summary with commit-frequency facts. */
export function stats(dbHandle, { login = null } = {}) {
  const base = db.dbStats(dbHandle);
  // dbStats counts users; here `users` carries the per-user detail array, so
  // rename the count to avoid the spread silently overwriting it.
  const { users: userCount, ...rest } = base;
  const users = db.listUsers(dbHandle).map((u) => {
    const freq = db.getCommitFrequency(dbHandle, u.id);
    const daily = freq.filter((f) => f.bucket.startsWith('D:')).map((f) => [f.bucket, f.count]);
    const hourly = freq.filter((f) => f.bucket.startsWith('H:')).map((f) => [f.bucket, f.count]);
    return {
      login: u.login, name: u.name, synced_at: u.synced_at,
      repos: u.public_repos, followers: u.followers,
      stored_repos: db.countRows(dbHandle, 'repos', 'user_id = ?', [u.id]),
      stored_commits: db.countRows(dbHandle, 'commits', 'user_id = ?', [u.id]),
      top_tags: db.listUserTags(dbHandle, u.id, { limit: 8 }).map((t) => `${t.name}(${t.weight.toFixed(2)})`),
      frequency: frequencySummary(daily, hourly),
    };
  });
  return { ...rest, user_count: userCount, users, login_filter: login ?? null };
}
