// SQLite persistence layer for the dev-agent-memory graph.
//
// Graph model (nodes):
//   users          — the developer being remembered
//   repos          — open-source assets (edges to user)
//   commits        — recent activity (edges to user + repo)
//   tags           — tech-stack vocabulary (languages, topics, licenses)
// Edges:
//   repo_tags     (repo <-> tag, weighted)
//   user_tags     (user <-> tag, aggregated)
// Plus derived/materialized facts:
//   code_features      (repo -> key/value core-code traits)
//   commit_frequency   (user -> daily/weekly/hourly buckets)
//   memory_index       (FTS5 search index over the whole graph)
//
// Zero runtime dependencies: node:sqlite ships with Node >= 24 (verified on v26).

import { DatabaseSync } from 'node:sqlite';
import { ensureDirFor } from './util.js';

const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY,
  login            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  github_id        INTEGER UNIQUE,
  name             TEXT,
  company          TEXT,
  location         TEXT,
  bio              TEXT,
  blog             TEXT,
  email            TEXT,
  avatar_url       TEXT,
  html_url         TEXT,
  public_repos     INTEGER DEFAULT 0,
  public_gists     INTEGER DEFAULT 0,
  followers        INTEGER DEFAULT 0,
  following        INTEGER DEFAULT 0,
  github_created_at TEXT,
  synced_at        TEXT
);

CREATE TABLE IF NOT EXISTS repos (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_github_id   INTEGER UNIQUE,
  full_name        TEXT NOT NULL COLLATE NOCASE,
  name             TEXT,
  owner_login      TEXT,
  description      TEXT,
  html_url         TEXT,
  is_private       INTEGER DEFAULT 0,
  is_fork          INTEGER DEFAULT 0,
  is_archived      INTEGER DEFAULT 0,
  stars            INTEGER DEFAULT 0,
  forks            INTEGER DEFAULT 0,
  watchers         INTEGER DEFAULT 0,
  open_issues      INTEGER DEFAULT 0,
  size_kb          INTEGER DEFAULT 0,
  default_branch   TEXT,
  language         TEXT,
  languages_json   TEXT,
  topics_json      TEXT,
  license          TEXT,
  repo_created_at  TEXT,
  repo_updated_at  TEXT,
  last_pushed_at   TEXT,
  synced_at        TEXT,
  UNIQUE(user_id, full_name)
);

CREATE TABLE IF NOT EXISTS commits (
  id               INTEGER PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id          INTEGER REFERENCES repos(id) ON DELETE SET NULL,
  repo_full_name   TEXT,
  sha              TEXT NOT NULL,
  message          TEXT,
  message_prefix   TEXT,
  author_name      TEXT,
  author_email     TEXT,
  authored_at      TEXT,
  day              TEXT,
  hour             INTEGER,
  additions        INTEGER,
  deletions        INTEGER,
  is_merge         INTEGER DEFAULT 0,
  UNIQUE(user_id, sha)
);

CREATE TABLE IF NOT EXISTS tags (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL COLLATE NOCASE,
  kind             TEXT NOT NULL DEFAULT 'tech',
  UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS repo_tags (
  repo_id          INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  tag_id           INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  weight           REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (repo_id, tag_id)
);

CREATE TABLE IF NOT EXISTS user_tags (
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag_id           INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  weight           REAL NOT NULL DEFAULT 0,
  hits             INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, tag_id)
);

CREATE TABLE IF NOT EXISTS code_features (
  repo_id          INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  feature          TEXT NOT NULL,
  value            TEXT,
  PRIMARY KEY (repo_id, feature)
);

CREATE TABLE IF NOT EXISTS commit_frequency (
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket           TEXT NOT NULL,
  count            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, bucket)
);

CREATE INDEX IF NOT EXISTS idx_commits_user_day   ON commits(user_id, day);
CREATE INDEX IF NOT EXISTS idx_commits_repo       ON commits(repo_id);
CREATE INDEX IF NOT EXISTS idx_repos_user_pushed  ON repos(user_id, last_pushed_at);
CREATE INDEX IF NOT EXISTS idx_repo_tags_tag      ON repo_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_user_tags_tag      ON user_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_freq_user          ON commit_frequency(user_id);

-- Full-text index over the memory graph (rebuilt at the end of each sync).
CREATE VIRTUAL TABLE IF NOT EXISTS memory_index USING fts5(
  entity_type, entity_id UNINDEXED, text, tokenize = 'unicode61'
);
`;

/** Open (or create) the memory database and run pending migrations. */
export function openDb(path) {
  ensureDirFor(path);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current < 1) {
    db.exec(SCHEMA_V1);
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/**
 * node:sqlite's DatabaseSync has no `.transaction()` helper (unlike better-sqlite3),
 * so we wrap the callable in explicit BEGIN/COMMIT/ROLLBACK. The returned function
 * keeps the same call shape: tx(args) commits on success, rolls back on throw.
 */
function makeTx(db, fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* connection already rolled back */ }
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Upsert a GitHub user profile. Returns the internal row id. */
export function upsertUser(db, profile, syncedAt = new Date().toISOString()) {
  const clean = (v) => (v == null ? null : String(v).trim() || null);
  db.prepare(`
    INSERT INTO users (login, github_id, name, company, location, bio, blog, email,
                       avatar_url, html_url, public_repos, public_gists,
                       followers, following, github_created_at, synced_at)
    VALUES (@login, @github_id, @name, @company, @location, @bio, @blog, @email,
            @avatar_url, @html_url, @public_repos, @public_gists,
            @followers, @following, @github_created_at, @synced_at)
    ON CONFLICT(login) DO UPDATE SET
      github_id=excluded.github_id, name=excluded.name, company=excluded.company,
      location=excluded.location, bio=excluded.bio, blog=excluded.blog, email=excluded.email,
      avatar_url=excluded.avatar_url, html_url=excluded.html_url,
      public_repos=excluded.public_repos, public_gists=excluded.public_gists,
      followers=excluded.followers, following=excluded.following,
      github_created_at=excluded.github_created_at, synced_at=excluded.synced_at
  `).run({
    login: clean(profile.login),
    github_id: profile.id ?? null,
    name: clean(profile.name), company: clean(profile.company),
    location: clean(profile.location), bio: clean(profile.bio),
    blog: clean(profile.blog), email: clean(profile.email),
    avatar_url: clean(profile.avatar_url), html_url: clean(profile.html_url),
    public_repos: profile.public_repos ?? 0, public_gists: profile.public_gists ?? 0,
    followers: profile.followers ?? 0, following: profile.following ?? 0,
    github_created_at: clean(profile.created_at), synced_at: syncedAt,
  });
  return getUserByLogin(db, profile.login).id;
}

export function getUserByLogin(db, login) {
  return db.prepare('SELECT * FROM users WHERE login = ? COLLATE NOCASE').get(login);
}

export function getUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function listUsers(db) {
  return db.prepare('SELECT * FROM users ORDER BY login COLLATE NOCASE').all();
}

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

/** Upsert a repo row. Returns internal row id. */
export function upsertRepo(db, userId, repo, syncedAt = new Date().toISOString()) {
  const clean = (v) => (v == null ? null : String(v).trim() || null);
  db.prepare(`
    INSERT INTO repos (
      user_id, repo_github_id, full_name, name, owner_login, description, html_url,
      is_private, is_fork, is_archived, stars, forks, watchers, open_issues,
      size_kb, default_branch, language, languages_json, topics_json, license,
      repo_created_at, repo_updated_at, last_pushed_at, synced_at)
    VALUES (
      @user_id, @repo_github_id, @full_name, @name, @owner_login, @description, @html_url,
      @is_private, @is_fork, @is_archived, @stars, @forks, @watchers, @open_issues,
      @size_kb, @default_branch, @language, @languages_json, @topics_json, @license,
      @repo_created_at, @repo_updated_at, @last_pushed_at, @synced_at)
    ON CONFLICT(user_id, full_name) DO UPDATE SET
      repo_github_id=excluded.repo_github_id, name=excluded.name,
      description=excluded.description, html_url=excluded.html_url,
      is_private=excluded.is_private, is_fork=excluded.is_fork, is_archived=excluded.is_archived,
      stars=excluded.stars, forks=excluded.forks, watchers=excluded.watchers,
      open_issues=excluded.open_issues, size_kb=excluded.size_kb,
      default_branch=excluded.default_branch, language=excluded.language,
      languages_json=excluded.languages_json, topics_json=excluded.topics_json,
      license=excluded.license, repo_created_at=excluded.repo_created_at,
      repo_updated_at=excluded.repo_updated_at, last_pushed_at=excluded.last_pushed_at,
      synced_at=excluded.synced_at
  `).run({
    user_id: userId,
    repo_github_id: repo.id ?? null,
    full_name: clean(repo.full_name), name: clean(repo.name),
    owner_login: clean(repo.owner?.login), description: clean(repo.description),
    html_url: clean(repo.html_url),
    is_private: repo.private ? 1 : 0, is_fork: repo.fork ? 1 : 0,
    is_archived: repo.archived ? 1 : 0,
    stars: repo.stargazers_count ?? 0, forks: repo.forks_count ?? 0,
    watchers: repo.watchers_count ?? 0, open_issues: repo.open_issues_count ?? 0,
    size_kb: repo.size ?? 0, default_branch: clean(repo.default_branch),
    language: clean(repo.language),
    languages_json: repo._languagesJson ?? null,
    topics_json: Array.isArray(repo.topics) ? JSON.stringify(repo.topics) : (repo._topicsJson ?? null),
    license: clean(typeof repo.license === 'string'
      ? repo.license
      : (repo.license?.spdx_id || repo.license?.name)),
    repo_created_at: clean(repo.created_at), repo_updated_at: clean(repo.updated_at),
    last_pushed_at: clean(repo.pushed_at), synced_at: syncedAt,
  });
  return db.prepare('SELECT id FROM repos WHERE user_id = ? AND full_name = ? COLLATE NOCASE')
    .get(userId, repo.full_name)?.id ?? null;
}

export function getRepoById(db, id) {
  return db.prepare('SELECT * FROM repos WHERE id = ?').get(id);
}

export function getRepoByName(db, userId, fullName) {
  return db.prepare('SELECT * FROM repos WHERE user_id = ? AND full_name = ? COLLATE NOCASE')
    .get(userId, fullName);
}

export function listRepos(db, userId, { tag = null, limit = 50, orderBy = 'last_pushed_at' } = {}) {
  if (tag) {
    return db.prepare(`
      SELECT r.* FROM repos r
      JOIN repo_tags rt ON rt.repo_id = r.id
      JOIN tags t ON t.id = rt.tag_id AND t.name = ? COLLATE NOCASE
      WHERE r.user_id = ?
      ORDER BY ${orderBy} DESC LIMIT ?`).all(tag, userId, limit);
  }
  return db.prepare(`SELECT * FROM repos WHERE user_id = ? ORDER BY ${orderBy} DESC LIMIT ?`)
    .all(userId, limit);
}

// ---------------------------------------------------------------------------
// Tags & graph edges
// ---------------------------------------------------------------------------

/** Get-or-create a tag, returns row id. Name is normalized to lowercase. */
export function upsertTag(db, name, kind = 'tech') {
  const n = String(name).trim().toLowerCase();
  db.prepare('INSERT INTO tags (name, kind) VALUES (?, ?) ON CONFLICT(name) DO NOTHING').run(n, kind);
  return db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(n)?.id ?? null;
}

/** Replace the tag set of a repo with the given weighted list. */
export function setRepoTags(db, repoId, tags /* [{name, kind, weight}] */) {
  const del = db.prepare('DELETE FROM repo_tags WHERE repo_id = ?');
  const ins = db.prepare('INSERT OR REPLACE INTO repo_tags (repo_id, tag_id, weight) VALUES (?, ?, ?)');
  const tx = makeTx(db, (rows) => {
    del.run(repoId);
    for (const t of rows) {
      const tagId = upsertTag(db, t.name, t.kind);
      if (tagId != null) ins.run(repoId, tagId, t.weight ?? 1.0);
    }
  });
  tx(tags || []);
}

/** Replace user-level aggregated tags. */
export function setUserTags(db, userId, tags /* [{name, kind, weight, hits}] */) {
  const del = db.prepare('DELETE FROM user_tags WHERE user_id = ?');
  const ins = db.prepare('INSERT OR REPLACE INTO user_tags (user_id, tag_id, weight, hits) VALUES (?, ?, ?, ?)');
  const tx = makeTx(db, (rows) => {
    del.run(userId);
    for (const t of rows) {
      const tagId = upsertTag(db, t.name, t.kind);
      if (tagId != null) ins.run(userId, tagId, t.weight ?? 0, t.hits ?? 0);
    }
  });
  tx(tags || []);
}

export function listTags(db, { minWeight = 0, limit = 100 } = {}) {
  return db.prepare(`
    SELECT t.name, t.kind, COUNT(rt.repo_id) AS repo_count, ROUND(SUM(rt.weight), 2) AS weight
    FROM tags t
    LEFT JOIN repo_tags rt ON rt.tag_id = t.id
    GROUP BY t.id, t.name, t.kind
    HAVING weight >= ? AND repo_count > 0
    ORDER BY weight DESC, repo_count DESC, t.name LIMIT ?`).all(minWeight, limit);
}

export function listUserTags(db, userId, { limit = 20 } = {}) {
  return db.prepare(`
    SELECT t.name, t.kind, ut.weight, ut.hits
    FROM user_tags ut JOIN tags t ON t.id = ut.tag_id
    WHERE ut.user_id = ?
    ORDER BY ut.weight DESC, ut.hits DESC, t.name LIMIT ?`).all(userId, limit);
}

/** Tags co-occurring with the given tag across repos — the memory-graph neighborhood. */
export function relatedTags(db, tag, { limit = 10 } = {}) {
  return db.prepare(`
    SELECT t2.name AS tag, t2.kind, COUNT(*) AS shared_repos
    FROM repo_tags rt1
    JOIN repo_tags rt2 ON rt2.repo_id = rt1.repo_id AND rt2.tag_id <> rt1.tag_id
    JOIN tags t1 ON t1.id = rt1.tag_id AND t1.name = ? COLLATE NOCASE
    JOIN tags t2 ON t2.id = rt2.tag_id
    GROUP BY t2.id ORDER BY shared_repos DESC, t2.name LIMIT ?`).all(tag, limit);
}

// ---------------------------------------------------------------------------
// Code features & commit frequency
// ---------------------------------------------------------------------------

/** Replace the key/value core-code features of a repo. */
export function setCodeFeatures(db, repoId, features /* Record<string, string|number> */) {
  const del = db.prepare('DELETE FROM code_features WHERE repo_id = ?');
  const ins = db.prepare('INSERT OR REPLACE INTO code_features (repo_id, feature, value) VALUES (?, ?, ?)');
  const tx = makeTx(db, (entries) => {
    del.run(repoId);
    for (const [feature, value] of entries) ins.run(repoId, feature, String(value ?? ''));
  });
  tx(Object.entries(features || {}));
}

export function getCodeFeatures(db, repoId) {
  return db.prepare('SELECT feature, value FROM code_features WHERE repo_id = ? ORDER BY feature')
    .all(repoId).map((r) => ({ feature: r.feature, value: r.value }));
}

/** Replace commit-frequency buckets for a user. buckets: Iterable<[bucket, count]> */
export function setCommitFrequency(db, userId, buckets) {
  const del = db.prepare('DELETE FROM commit_frequency WHERE user_id = ?');
  const ins = db.prepare('INSERT OR REPLACE INTO commit_frequency (user_id, bucket, count) VALUES (?, ?, ?)');
  const tx = makeTx(db, (rows) => {
    del.run(userId);
    for (const [bucket, count] of rows) ins.run(userId, bucket, count);
  });
  tx(buckets || []);
}

export function getCommitFrequency(db, userId, { kind = null, limit = 400 } = {}) {
  const prefix = kind ? `${kind}:` : '';
  return db.prepare(`
    SELECT bucket, count, SUBSTR(bucket, INSTR(bucket, ':') + 1) AS label
    FROM commit_frequency WHERE user_id = ? AND bucket LIKE ? ESCAPE '\\'
    ORDER BY bucket DESC LIMIT ?`).all(userId, `${prefix}%`, limit);
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

/** Insert one cleaned commit row; ignores duplicates (UNIQUE user_id, sha). Returns true when actually inserted. */
export function insertCommit(db, c) {
  try {
    const result = db.prepare(`
      INSERT OR IGNORE INTO commits (
        user_id, repo_id, repo_full_name, sha, message, message_prefix,
        author_name, author_email, authored_at, day, hour,
        additions, deletions, is_merge)
      VALUES (@user_id, @repo_id, @repo_full_name, @sha, @message, @message_prefix,
              @author_name, @author_email, @authored_at, @day, @hour,
              @additions, @deletions, @is_merge)`).run({
      user_id: c.userId, repo_id: c.repoId ?? null,
      repo_full_name: c.repoFullName ?? null, sha: c.sha,
      message: c.message ?? null, message_prefix: c.prefix ?? null,
      author_name: c.authorName ?? null, author_email: c.authorEmail ?? null,
      authored_at: c.authoredAt ?? null, day: c.day ?? null,
      hour: c.hour ?? null, additions: c.additions ?? null,
      deletions: c.deletions ?? null, is_merge: c.isMerge ? 1 : 0,
    });
    // INSERT OR IGNORE swallows the UNIQUE conflict without throwing, so the
    // only way to tell "stored" from "duplicate" is the change count.
    return (result?.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

export function listCommits(db, { userId = null, repoId = null, repoFullName = null, limit = 30, since = null } = {}) {
  const where = [];
  const params = [];
  if (userId) { where.push('c.user_id = ?'); params.push(userId); }
  if (repoId) { where.push('c.repo_id = ?'); params.push(repoId); }
  if (repoFullName) { where.push('c.repo_full_name = ? COLLATE NOCASE'); params.push(repoFullName); }
  if (since) { where.push('c.day >= ?'); params.push(since); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`
    SELECT c.*, r.full_name AS repo_display
    FROM commits c LEFT JOIN repos r ON r.id = c.repo_id
    ${clause} ORDER BY c.authored_at DESC LIMIT ?`).all(...params, limit);
}

export function getCommitById(db, id) {
  return db.prepare('SELECT * FROM commits WHERE id = ?').get(id);
}

export function getTagById(db, id) {
  return db.prepare('SELECT name, kind FROM tags WHERE id = ?').get(id);
}

/** Plain LIKE fallback used when the FTS vocabulary has no hit. */
export function likeSearch(db, query, { limit = 25 } = {}) {
  const like = `%${String(query).replace(/[%_]/g, ' ')}%`;
  const repos = db.prepare(`
    SELECT id, full_name, description, language, stars, html_url, last_pushed_at
    FROM repos WHERE full_name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'
    OR language LIKE ? ESCAPE '\\' ORDER BY last_pushed_at DESC LIMIT ?`)
    .all(like, like, like, limit);
  const commits = db.prepare(`
    SELECT id, sha, message, day, repo_full_name, message_prefix
    FROM commits WHERE message LIKE ? ESCAPE '\\' ORDER BY day DESC LIMIT ?`)
    .all(like, limit);
  return { repos, commits };
}

/** COUNT(*) helper. */
export function countRows(db, table, where = '', params = []) {
  const clause = where ? ` WHERE ${where}` : '';
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}${clause}`).get(...params).n;
}

// ---------------------------------------------------------------------------
// Search index (FTS5)
// ---------------------------------------------------------------------------

/** Rebuild the FTS5 index from the current graph content. Called after each sync. */
export function rebuildIndex(db) {
  const tx = makeTx(db, () => {
    db.exec('DELETE FROM memory_index');
    const ins = db.prepare('INSERT INTO memory_index (entity_type, entity_id, text) VALUES (?, ?, ?)');
    for (const u of db.prepare('SELECT id, login, name, bio, company, location FROM users').all()) {
      ins.run('user', u.id, [u.login, u.name, u.bio, u.company, u.location].filter(Boolean).join(' \n '));
    }
    for (const r of db.prepare(
      'SELECT id, full_name, description, language, topics_json, license FROM repos').all()) {
      let topics = [];
      try { topics = JSON.parse(r.topics_json || '[]'); } catch { /* keep empty */ }
      ins.run('repo', r.id,
        [r.full_name, r.description, r.language, r.license, topics.join(' ')].filter(Boolean).join(' \n '));
    }
    for (const c of db.prepare('SELECT id, message, repo_full_name FROM commits').all()) {
      ins.run('commit', c.id, [c.repo_full_name, c.message].filter(Boolean).join(' \n '));
    }
    for (const t of db.prepare('SELECT id, name, kind FROM tags').all()) {
      ins.run('tag', t.id, `${t.name} ${t.kind}`);
    }
  });
  tx();
  return db.prepare('SELECT COUNT(*) AS n FROM memory_index').get().n;
}

/** Run a full-text MATCH against the index. Returns bare rows ordered by bm25. */
export function ftsSearch(db, matchExpr, { limit = 25 } = {}) {
  return db.prepare(`
    SELECT entity_type, entity_id, bm25(memory_index) AS rank
    FROM memory_index WHERE memory_index MATCH ?
    ORDER BY rank LIMIT ?`).all(matchExpr, limit);
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function dbStats(db) {
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const topLangs = db.prepare(`
    SELECT language, COUNT(*) AS n FROM repos
    WHERE language IS NOT NULL GROUP BY language ORDER BY n DESC LIMIT 5`).all();
  const lastSync = db.prepare('SELECT login, synced_at FROM users ORDER BY synced_at DESC LIMIT 1').get();
  return {
    users: count('users'), repos: count('repos'), commits: count('commits'),
    tags: count('tags'), edges: count('repo_tags'), features: count('code_features'),
    index_size: count('memory_index'),
    top_languages: topLangs, last_sync: lastSync ?? null,
  };
}
