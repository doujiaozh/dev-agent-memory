import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';

import {
  openDb, upsertUser, getUserByLogin, getUserById, listUsers,
  upsertRepo, getRepoByName, listRepos,
  upsertTag, setRepoTags, setUserTags, listTags, listUserTags, relatedTags,
  setCodeFeatures, getCodeFeatures,
  setCommitFrequency, getCommitFrequency,
  insertCommit, listCommits, getCommitById,
  likeSearch, countRows, rebuildIndex, ftsSearch, dbStats,
} from '../src/db.js';

const PROFILE = {
  login: 'demodev', id: 424242, name: 'Demo Developer', company: 'Acme',
  location: 'Shanghai', bio: 'polyglot builder', blog: 'https://demodev.dev',
  email: null, avatar_url: 'https://avatars.example.com/u/424242',
  html_url: 'https://github.com/demodev', public_repos: 6, public_gists: 2,
  followers: 128, following: 12, created_at: '2014-03-11T08:00:00Z',
};

// GitHub repo ids are globally unique, so every fixture repo needs its own.
let repoSeq = 100;
const repo = (over = {}) => ({
  id: ++repoSeq, full_name: 'demodev/rust-queue', name: 'rust-queue',
  owner: { login: 'demodev' }, description: 'lock-free queue',
  html_url: 'https://github.com/demodev/rust-queue', private: false,
  fork: false, archived: false, stargazers_count: 42, forks_count: 3,
  watchers_count: 5, open_issues_count: 7, size: 3200, default_branch: 'main',
  language: 'Rust', topics: ['rust', 'queue'],
  license: { spdx_id: 'MIT' }, created_at: '2021-05-02T10:00:00Z',
  updated_at: '2021-05-03T10:00:00Z', pushed_at: '2021-05-04T10:00:00Z',
  ...over,
});

const openMemory = () => openDb(':memory:');

describe('openDb & migration', () => {
  test('schema v1 creates all tables and pragmas', () => {
    const db = openMemory();
    const version = db.prepare('PRAGMA user_version').get().user_version;
    assert.equal(version, 1);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((t) => t.name);
    for (const t of ['users', 'repos', 'commits', 'tags', 'repo_tags', 'user_tags',
      'code_features', 'commit_frequency', 'memory_index']) {
      assert.ok(tables.includes(t), `missing table ${t}`);
    }
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    db.close();
  });

  test('reopening an existing db file keeps the version and data', () => {
    const file = `db-reopen-${process.pid}.db`;
    if (existsSync(file)) unlinkSync(file);
    let db = openDb(file); // sqlite creates the file; migration runs on first open
    upsertUser(db, PROFILE);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    db.close();
    db = openDb(file); // reopen: migration must be a no-op, row preserved
    assert.equal(getUserByLogin(db, 'demodev').github_id, 424242);
    assert.equal(listUsers(db).length, 1);
    db.close();
    if (existsSync(file)) unlinkSync(file);
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(file + ext)) unlinkSync(file + ext);
    }
  });
});

describe('users & repos DAO', () => {
  test('upsertUser is idempotent and updates profile fields', () => {
    const db = openMemory();
    const id1 = upsertUser(db, PROFILE, '2026-01-01T00:00:00Z');
    const id2 = upsertUser(db, { ...PROFILE, followers: 999 }, '2026-02-01T00:00:00Z');
    assert.equal(id1, id2);
    const row = getUserByLogin(db, 'demodev');
    assert.equal(row.followers, 999);
    assert.equal(row.synced_at, '2026-02-01T00:00:00Z');
    assert.equal(getUserById(db, id1).login, 'demodev');
    assert.equal(listUsers(db).length, 1);
    db.close();
  });

  test('upsertRepo is idempotent, tolerates license object or string, stores topics', () => {
    const db = openMemory();
    const uid = upsertUser(db, PROFILE);
    const id1 = upsertRepo(db, uid, repo(), '2026-01-01T00:00:00Z');
    const id2 = upsertRepo(db, uid, repo({ stargazers_count: 7 }), '2026-02-01T00:00:00Z');
    assert.equal(id1, id2);
    const row = getRepoByName(db, uid, 'demodev/rust-queue');
    assert.equal(row.stars, 7);
    assert.equal(row.license, 'MIT');
    assert.deepEqual(JSON.parse(row.topics_json), ['rust', 'queue']);
    assert.equal(row.is_fork, 0);

    // license as plain string
    upsertRepo(db, uid, repo({ full_name: 'demodev/other', license: 'Apache-2.0' }));
    assert.equal(getRepoByName(db, uid, 'demodev/other').license, 'Apache-2.0');
    db.close();
  });

  test('listRepos orders by last push and filters by tag', () => {
    const db = openMemory();
    const uid = upsertUser(db, PROFILE);
    upsertRepo(db, uid, repo({ full_name: 'demodev/old', pushed_at: '2020-01-01T00:00:00Z' }));
    upsertRepo(db, uid, repo({ full_name: 'demodev/new', pushed_at: '2026-01-01T00:00:00Z' }));
    const byPush = listRepos(db, uid);
    assert.equal(byPush[0].full_name, 'demodev/new');
    setRepoTags(db, byPush[0].id, [{ name: 'rust', kind: 'tech', weight: 2 }]);
    const filtered = listRepos(db, uid, { tag: 'rust' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].full_name, 'demodev/new');
    db.close();
  });
});

describe('tags & graph edges', () => {
  test('upsertTag normalizes to lowercase and reuses ids', () => {
    const db = openMemory();
    const a = upsertTag(db, 'Rust');
    const b = upsertTag(db, 'rust', 'lang');
    assert.equal(a, b);
    const row = db.prepare('SELECT name, kind FROM tags WHERE id = ?').get(a);
    assert.equal(row.name, 'rust');
    db.close();
  });

  test('setRepoTags replaces the whole set', () => {
    const db = openMemory();
    const uid = upsertUser(db, PROFILE);
    const rid = upsertRepo(db, uid, repo());
    setRepoTags(db, rid, [
      { name: 'rust', weight: 2 }, { name: 'queue', weight: 1 }, { name: 'mit', weight: 0.5 },
    ]);
    assert.equal(countRows(db, 'repo_tags', 'repo_id = ?', [rid]), 3);
    setRepoTags(db, rid, [{ name: 'rust', weight: 2 }]);
    assert.equal(countRows(db, 'repo_tags', 'repo_id = ?', [rid]), 1);
    db.close();
  });

  test('listTags aggregates repo counts and weights', () => {
    const db = openMemory();
    const uid = upsertUser(db, PROFILE);
    const r1 = upsertRepo(db, uid, repo());
    const r2 = upsertRepo(db, uid, repo({ full_name: 'demodev/other' }));
    setRepoTags(db, r1, [{ name: 'rust', weight: 2 }, { name: 'queue', weight: 1 }]);
    setRepoTags(db, r2, [{ name: 'rust', weight: 1.5 }]);
    const tags = listTags(db);
    const rust = tags.find((t) => t.name === 'rust');
    assert.equal(rust.repo_count, 2);
    assert.equal(rust.weight, 3.5);
    assert.equal(tags[0].name, 'rust'); // heaviest first
    db.close();
  });

  test('relatedTags finds the co-occurrence neighborhood', () => {
    const db = openMemory();
    const uid = upsertUser(db, PROFILE);
    const rid = upsertRepo(db, uid, repo());
    setRepoTags(db, rid, [{ name: 'rust', weight: 2 }, { name: 'queue', weight: 1 }, { name: 'mit', weight: 0.5 }]);
    const related = relatedTags(db, 'rust').map((r) => r.tag);
    assert.ok(related.includes('queue'));
    assert.ok(related.includes('mit'));
    assert.equal(relatedTags(db, 'nope').length, 0);
    db.close();
  });

  test('setUserTags stores aggregated weights and hits', () => {
    const db = openMemory();
    const uid = upsertUser(db, PROFILE);
    setUserTags(db, uid, [{ name: 'rust', weight: 9.5, hits: 4 }, { name: 'shell', weight: 0.7, hits: 1 }]);
    const tags = listUserTags(db, uid);
    assert.equal(tags[0].name, 'rust');
    assert.equal(tags[0].hits, 4);
    setUserTags(db, uid, [{ name: 'go', weight: 3 }]);
    assert.equal(listUserTags(db, uid).length, 1); // replaced, not appended
    db.close();
  });
});

describe('code features & frequency', () => {
  test('setCodeFeatures replaces key/value pairs', () => {
    const db = openMemory();
    const uid = upsertUser(db, PROFILE);
    const rid = upsertRepo(db, uid, repo());
    setCodeFeatures(db, rid, { size_tier: 'medium', star_tier: 'known', open_issues: 21 });
    let feats = getCodeFeatures(db, rid);
    assert.equal(feats.find((f) => f.feature === 'size_tier').value, 'medium');
    setCodeFeatures(db, rid, { size_tier: 'large' });
    feats = getCodeFeatures(db, rid);
    assert.equal(feats.length, 1);
    db.close();
  });

  test('frequency buckets are filtered by kind prefix', () => {
    const db = openMemory();
    const uid = upsertUser(db, PROFILE);
    setCommitFrequency(db, uid, [
      ['D:2026-10-01', 3], ['D:2026-10-02', 1],
      ['W:2026-W40', 4], ['H:09', 2], ['H:23', 1],
    ]);
    assert.equal(getCommitFrequency(db, uid).length, 5);
    assert.equal(getCommitFrequency(db, uid, { kind: 'D' }).length, 2);
    assert.equal(getCommitFrequency(db, uid, { kind: 'H' }).length, 2);
    const h = getCommitFrequency(db, uid, { kind: 'H' });
    assert.equal(h[0].label, '23'); // ordered by bucket DESC
    setCommitFrequency(db, uid, [['D:2026-10-03', 2]]);
    assert.equal(getCommitFrequency(db, uid).length, 1); // replaced
    db.close();
  });
});

describe('commits DAO', () => {
  const commitRow = (uid, sha, over = {}) => ({
    userId: uid, sha, message: 'feat: x', prefix: 'feat',
    authorName: 'Demo', authorEmail: 'demo@dev.dev',
    authoredAt: '2026-10-25T09:00:00Z', day: '2026-10-25', hour: 9,
    ...over,
  });

  test('insertCommit ignores duplicate (user, sha) pairs', () => {
    const db = openMemory();
    const uid = upsertUser(db, PROFILE);
    insertCommit(db, commitRow(uid, 'a'.repeat(40)));
    insertCommit(db, commitRow(uid, 'a'.repeat(40), { message: 'changed' }));
    assert.equal(countRows(db, 'commits'), 1);
    const row = getCommitById(db, 1);
    assert.equal(row.message, 'feat: x');
    db.close();
  });

  test('listCommits filters by user / repo full name / since', () => {
    const db = openMemory();
    const uid = upsertUser(db, PROFILE);
    const rid = upsertRepo(db, uid, repo());
    insertCommit(db, commitRow(uid, 'a'.repeat(40), { repoId: rid, repoFullName: 'demodev/rust-queue', day: '2026-10-25' }));
    insertCommit(db, commitRow(uid, 'b'.repeat(40), { repoFullName: 'demodev/demoshell', day: '2026-10-20' }));
    assert.equal(listCommits(db, { userId: uid }).length, 2);
    assert.equal(listCommits(db, { repoId: rid }).length, 1);
    assert.equal(listCommits(db, { repoFullName: 'demodev/demoshell' }).length, 1);
    assert.equal(listCommits(db, { userId: uid, since: '2026-10-24' }).length, 1);
    db.close();
  });
});

describe('search index', () => {
  const seed = (db) => {
    const uid = upsertUser(db, PROFILE);
    const rid = upsertRepo(db, uid, repo({ description: 'lock-free multi-producer queue' }));
    setRepoTags(db, rid, [{ name: 'rust', weight: 2 }, { name: 'lock-free', weight: 1 }]);
    insertCommit(db, {
      userId: uid, sha: 'a'.repeat(40), message: 'feat(queue): segmented ring buffer',
      prefix: 'feat', day: '2026-10-25', hour: 9, authoredAt: '2026-10-25T09:00:00Z',
    });
    return { uid, rid };
  };

  test('rebuildIndex covers users, repos, commits and tags', () => {
    const db = openMemory();
    seed(db);
    const n = rebuildIndex(db);
    // 1 user + 1 repo + 1 commit + 2 tags
    assert.equal(n, 5);
    db.close();
  });

  test('ftsSearch matches and ranks with bm25', () => {
    const db = openMemory();
    seed(db);
    rebuildIndex(db);
    const hits = ftsSearch(db, 'queue');
    assert.ok(hits.length >= 2);
    const kinds = new Set(hits.map((h) => h.entity_type));
    assert.ok(kinds.has('repo'));
    assert.ok(kinds.has('commit'));
    db.close();
  });

  test('likeSearch falls back over repos and commits', () => {
    const db = openMemory();
    seed(db);
    const res = likeSearch(db, 'lock-free');
    assert.ok(res.repos.length >= 1);
    assert.equal(res.repos[0].full_name, 'demodev/rust-queue');
    db.close();
  });
});

describe('dbStats', () => {
  test('counts rows across the graph', () => {
    const db = openMemory();
    const uid = upsertUser(db, PROFILE);
    upsertRepo(db, uid, repo());
    setRepoTags(db, 1, [{ name: 'rust', weight: 2 }]);
    const stats = dbStats(db);
    assert.equal(stats.users, 1);
    assert.equal(stats.repos, 1);
    assert.equal(stats.tags, 1);
    assert.equal(stats.edges, 1);
    assert.equal(stats.last_sync.login, 'demodev');
    assert.equal(stats.top_languages[0].language, 'Rust');
    assert.equal(stats.top_languages[0].n, 1);
    db.close();
  });
});
