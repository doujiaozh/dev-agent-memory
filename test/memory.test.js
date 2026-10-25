// End-to-end tests: sync the fixture user through the mock GitHub API, then
// exercise the query surface (find / route / graph / stats) against a real
// SQLite graph built from scratch.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { syncUser, find, route, tagGraph, stats } from '../src/memory.js';
import { GitHubClient } from '../src/github.js';
import { startServer } from './mock-server.js';

describe('syncUser + query surface (offline e2e)', () => {
  let server, db, client;

  before(async () => {
    server = await startServer();
    db = openDb(':memory:');
    client = new GitHubClient({ baseUrl: server.baseUrl });
  });

  after(() => {
    try { db?.close(); } catch { /* ignore */ }
    server?.close();
  });

  test('sync pulls profile, repos and commits into the graph', async () => {
    const summary = await syncUser(db, 'demodev', { client });
    assert.equal(summary.user, 'demodev');
    assert.equal(summary.repos_synced, 6); // 5 owned + 1 fork (linux)
    assert.equal(summary.commits_seen, 10); // 4 PushEvents x commits
    assert.equal(summary.commits_stored, 9); // one duplicated sha is ignored
    assert.equal(summary.languages_fetched, 3); // top-3 active non-fork repos
    assert.ok(summary.index_size > 0);
    assert.equal(summary.rate_limit.remaining, 4987);
  });

  test('unknown user is reported, not silently stored', async () => {
    await assert.rejects(() => syncUser(db, 'ghost', { client }), /GitHub user not found: ghost/);
  });

  test('re-sync is idempotent', async () => {
    const summary = await syncUser(db, 'demodev', { client });
    assert.equal(summary.commits_stored, 0);
    assert.equal(summary.repos_synced, 6);
  });

  test('commitLimit caps the harvest', async () => {
    const summary = await syncUser(db, 'demodev', { client, commitLimit: 3 });
    assert.equal(summary.commits_seen, 3);
    assert.ok(summary.commits_stored <= 3);
  });

  test("find 'rust' hits the rust repo and the rust tag", () => {
    const r = find(db, 'rust');
    assert.ok(r.tag_hits.some((t) => t.name === 'rust'), `tag hits: ${r.tag_hits.map((t) => t.name)}`);
    assert.ok(r.repos.some((x) => x.full_name === 'demodev/rust-queue'));
    assert.equal(r.fallback, undefined);
  });

  test("find 'lock-free' resolves a topic to its repo", () => {
    const r = find(db, 'lock-free');
    assert.ok(r.tag_hits.some((t) => t.name === 'lock-free'));
    assert.ok(r.repos.some((x) => x.full_name === 'demodev/rust-queue'));
  });

  test("find with unknown terms falls back to LIKE search", () => {
    const r = find(db, 'nonexistent-zzz');
    assert.equal(r.fallback, 'like');
    assert.deepEqual(r.repos, []);
  });

  test('find kind filter restricts result groups', () => {
    const reposOnly = find(db, 'rust', { kind: 'repo' });
    assert.ok(reposOnly.repos.length > 0);
    assert.equal(reposOnly.commits.length, 0);
    const commitsOnly = find(db, 'rust', { kind: 'commit' });
    assert.ok(commitsOnly.commits.length > 0, 'rust-queue commits match via repo_full_name');
    assert.equal(commitsOnly.repos.length, 0);
  });

  test("route 'rust' builds an asset routing card", () => {
    const card = route(db, 'rust');
    assert.equal(card.tag, 'rust');
    assert.ok(card.repos.some((r) => r.full_name === 'demodev/rust-queue'));
    const rr = card.repos.find((r) => r.full_name === 'demodev/rust-queue');
    assert.equal(rr.language, 'Rust');
    assert.ok(rr.features.size_tier);
    assert.ok(rr.features.star_tier);
    assert.ok(card.related_tags.some((t) => ['queue', 'concurrency', 'lock-free'].includes(t.tag)));
    assert.ok(card.recent_commits.every((c) => c.repo?.includes('rust-queue')));
  });

  test("tagGraph 'rust' exposes the co-occurrence neighborhood", () => {
    const g = tagGraph(db, 'rust');
    assert.equal(g.tag, 'rust');
    assert.ok(g.repo_count >= 1);
    assert.ok(g.weight > 0);
    const names = g.neighbors.map((n) => n.tag);
    assert.ok(names.some((n) => ['queue', 'concurrency', 'lock-free'].includes(n)), `neighbors: ${names}`);
  });

  test('stats aggregates the whole memory library', async () => {
    // The commitLimit test above left a partial aggregation in user_tags
    // (setUserTags replaces the whole set), so restore the full picture first.
    await syncUser(db, 'demodev', { client });
    const s = stats(db);
    assert.equal(s.user_count, 1);
    assert.equal(s.repos, 6);
    assert.equal(s.commits, 9);
    assert.ok(s.tags > 0);
    const u = s.users[0];
    assert.equal(u.login, 'demodev');
    assert.equal(u.stored_commits, 9);
    assert.ok(u.top_tags.some((t) => t.startsWith('rust')), `top_tags: ${u.top_tags}`);
    assert.equal(u.frequency.total_commits, 9);
    assert.ok(u.frequency.active_days >= 1);
  });
});
