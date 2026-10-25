#!/usr/bin/env node
//
// dev-agent-memory CLI — `memory`
//
//   memory sync <login> [--deep N|--no-deep] [--repos N] [--commits N]
//   memory find <query> [--kind repo|commit|tag|user] [--limit N]
//   memory user [login]
//   memory tags [--min N] [--limit N]
//   memory repos [--tag t] [--limit N] [--json]
//   memory commits [--repo owner/name] [--limit N] [--since YYYY-MM-DD]
//   memory route <tag>
//   memory graph <tag>
//   memory stats
//   memory version | help
//
// Global flags: --db <path> (env DEV_MEMORY_DB) | --api <url> (env GITHUB_API_BASE)
//               --token <pat> (env GITHUB_TOKEN) | --json | --quiet

import { openDb } from '../src/db.js';
import * as memory from '../src/memory.js';
import * as dbStore from '../src/db.js';
import { GitHubClient } from '../src/github.js';
import { frequencySummary } from '../src/derive.js';
import { VERSION, ago, compact, defaultDbPath, log } from '../src/util.js';

const args = parseArgs(process.argv.slice(2));
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  head: (s) => (color ? `\x1b[1;36m${s}\x1b[0m` : s),
  muted: (s) => (color ? `\x1b[2m${s}\x1b[0m` : s),
  accent: (s) => (color ? `\x1b[35m${s}\x1b[0m` : s),
  ok: (s) => (color ? `\x1b[32m${s}\x1b[0m` : s),
  warn: (s) => (color ? `\x1b[33m${s}\x1b[0m` : s),
  bold: (s) => (color ? `\x1b[1m${s}\x1b[0m` : s),
};

main().catch((err) => {
  if (process.env.DEV_MEMORY_LOG === 'debug') console.error(err);
  console.error(`${c.warn('error:')} ${err.message}`);
  process.exit(1);
});

async function main() {
  if (args.flags.version) return printVersion();
  const cmd = args.command;
  if (!cmd || cmd === 'help' || args.flags.help) return printHelp(cmd);

  switch (cmd) {
    case 'sync': return cmdSync();
    case 'find': return cmdFind();
    case 'user': return cmdUser();
    case 'tags': return cmdTags();
    case 'repos': return cmdRepos();
    case 'commits': return cmdCommits();
    case 'route': return cmdRoute();
    case 'graph': return cmdGraph();
    case 'stats': return cmdStats();
    default:
      console.error(`${c.warn('unknown command:')} ${cmd}`);
      printHelp();
      process.exit(2);
  }
}

// ---- argument parsing -------------------------------------------------------

function parseArgs(argv) {
  const out = { command: null, positionals: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [key, inline] = a.slice(2).split('=');
      const name = key.replace(/-./g, (m) => m[1].toUpperCase());
      if (inline !== undefined) out.flags[name] = inline;
      else if (isNextFlag(argv[i + 1])) out.flags[name] = true;
      else if (argv[i + 1] !== undefined) out.flags[name] = argv[++i];
      else out.flags[name] = true;
    } else if (!out.command) out.command = a;
    else out.positionals.push(a);
  }
  // multi-word positional support: `memory find rust async` -> query "rust async"
  if (['find', 'route', 'graph'].includes(out.command)) {
    out.flags.query = [out.positionals[0], ...out.positionals.slice(1)].join(' ').trim();
  } else if (out.command) {
    out.flags.subject = out.positionals[0] ?? null;
  }
  return out;
}

function isNextFlag(v) { return typeof v === 'string' && v.startsWith('--'); }

function flag(name, fallback = null) {
  const v = args.flags[name];
  return v === undefined || v === true ? fallback : v;
}
function numFlag(name, fallback) {
  const v = args.flags[name];
  if (v === undefined || v === true || v === false) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function openStore() {
  const path = flag('db') || defaultDbPath();
  const dbh = openDb(path);
  if (!flag('quiet', false)) log.debug(`db: ${path}`);
  return { dbh, path };
}

function asJson(v) { return JSON.stringify(v, null, 2); }

// ---- commands ---------------------------------------------------------------

async function cmdSync() {
  const login = flag('subject');
  if (!login) { console.error('usage: memory sync <github-login>'); process.exit(2); }
  const { dbh, path } = openStore();
  const client = new GitHubClient({
    baseUrl: flag('api') || undefined,
    token: flag('token') || undefined,
  });
  const deep = args.flags.noDeep ? 0 : numFlag('deep', 3);
  if (!flag('quiet', false)) {
    log.info(`syncing ${c.bold(login)} from ${client.baseUrl} ${client.token ? '(authenticated)' : '(anonymous)'}`);
  }
  const summary = await memory.syncUser(dbh, login, {
    client,
    repoLimit: numFlag('repos', 100),
    commitLimit: numFlag('commits', 500),
    deepLangRepos: deep,
    onProgress: (m) => log.debug(m),
  });
  if (args.flags.json) {
    console.log(asJson({ ...summary, db_path: path }));
  } else {
    console.log(`${c.ok('✔ synced')} ${c.bold(summary.user)}`);
    console.log(`  repos: ${summary.repos_synced}   commits: ${summary.commits_stored} (seen ${summary.commits_seen})`);
    console.log(`  language maps: ${summary.languages_fetched}   index: ${summary.index_size} docs`);
    if (summary.rate_limit.remaining != null) {
      console.log(`  rate limit: ${summary.rate_limit.remaining}/${summary.rate_limit.limit}`);
    }
    console.log(`  ${c.muted(`elapsed ${summary.elapsed_ms}ms · store: ${path}`)}`);
  }
  dbh.close();
}

function cmdFind() {
  const query = flag('query');
  if (!query) { console.error("usage: memory find <query>  e.g. memory find 'rust'"); process.exit(2); }
  const { dbh } = openStore();
  const res = memory.find(dbh, query, { kind: flag('kind'), limit: numFlag('limit', 25) });
  if (args.flags.json) console.log(asJson(res));
  else printFind(res);
  dbh.close();
}

function printFind(res) {
  console.log(c.head(`▎find: ${res.query}`));
  if (!res.tag_hits.length && !res.repos.length && !res.commits.length && !res.users.length && !res.tags.length) {
    console.log(`  ${c.muted('no memory matched — run `memory sync <login>` first.')}`);
    return;
  }
  if (res.tag_hits.length) {
    console.log(`\n  ${c.bold('tags')}`);
    for (const t of res.tag_hits.slice(0, 5)) {
      console.log(`    ${c.accent(t.name)} ${c.muted(`(${t.kind}) · ${t.repo_count} repos · w=${t.weight}`)}`);
    }
  }
  if (res.repos.length) {
    console.log(`\n  ${c.bold('repos')}`);
    for (const r of res.repos) {
      console.log(`    ${c.bold(r.full_name)} ${r.activity_tier ? c.muted(`[${r.activity_tier}]`) : ''} ${r.language ? c.accent(r.language) : ''} ${c.muted(compact(r.stars) + '★ · ' + ago(r.last_pushed_at))}`);
      if (r.description) console.log(`      ${c.muted(r.description)}`);
    }
  }
  if (res.commits.length) {
    console.log(`\n  ${c.bold('commits')}`);
    for (const cmt of res.commits.slice(0, 10)) {
      const prefix = cmt.prefix ? c.accent(cmt.prefix + ':') : '';
      console.log(`    ${c.muted(cmt.day)} ${c.muted(cmt.sha)} ${prefix} ${(cmt.message || '').slice(0, 90)}`);
    }
  }
  if (res.users.length) {
    console.log(`\n  ${c.bold('users')}`);
    for (const u of res.users) {
      console.log(`    ${c.bold(u.login)} ${c.muted(`· ${u.public_repos} public repos`)} ${u.top_tags.length ? c.muted('· ' + u.top_tags.join(', ')) : ''}`);
    }
  }
  if (res.tags.length) {
    console.log(`\n  ${c.bold('more tags')}`);
    console.log(`    ${res.tags.map((t) => `${c.accent(t.name)} ${c.muted(`(${t.kind})`)}`).join('  ')}`);
  }
  if (res.fallback) console.log(`\n  ${c.muted('(matched via LIKE fallback — FTS index may need a re-sync)')}`);
}

function cmdUser() {
  const login = flag('subject');
  const { dbh } = openStore();
  const users = login ? [dbStore.getUserByLogin(dbh, login)].filter(Boolean) : dbStore.listUsers(dbh);
  if (!users.length) { console.error(login ? `no memory for user ${login} — run \`memory sync ${login}\`` : 'no users synced yet'); process.exit(1); }
  const res = users.map((u) => {
    const freq = dbStore.getCommitFrequency(dbh, u.id);
    const daily = freq.filter((f) => f.bucket.startsWith('D:')).map((f) => [f.bucket, f.count]);
    const hourly = freq.filter((f) => f.bucket.startsWith('H:')).map((f) => [f.bucket, f.count]);
    return { ...u, top_tags: dbStore.listUserTags(dbh, u.id, { limit: 12 }), frequency: frequencySummary(daily, hourly) };
  });
  if (args.flags.json) console.log(asJson(res.length === 1 ? res[0] : res));
  else {
    for (const u of res) {
      console.log(c.head(`▎${u.login}`) + (u.name ? c.muted(` · ${u.name}`) : ''));
      if (u.bio) console.log(`  ${c.muted(u.bio)}`);
      console.log(`  repos: ${u.public_repos} · followers: ${u.followers} · synced: ${ago(u.synced_at)}`);
      console.log(`  ${c.bold('top tags:')} ${u.top_tags.map((t) => `${c.accent(t.name)} ${c.muted(t.weight.toFixed(2))}`).join('  ')}`);
      const f = u.frequency;
      console.log(`  ${c.bold('commits:')} ${f.total_commits} in ${f.active_days} active days · longest streak ${f.longest_streak}d` +
        (f.peak_hour ? ` · peak hour ${String(f.peak_hour.hour).padStart(2, '0')}:00 (${f.peak_hour.count})` : ''));
    }
  }
  dbh.close();
}

function cmdTags() {
  const { dbh } = openStore();
  const tags = dbStore.listTags(dbh, { minWeight: Number(flag('min', 0)), limit: numFlag('limit', 100) });
  if (args.flags.json) console.log(asJson(tags));
  else {
    console.log(c.head('▎tech stack tags'));
    for (const t of tags) console.log(`  ${c.accent(t.name.padEnd(18))} ${c.muted(t.kind.padEnd(9))} ${String(t.repo_count).padStart(4)} repos  w=${t.weight}`);
  }
  dbh.close();
}

function cmdRepos() {
  const { dbh } = openStore();
  const users = dbStore.listUsers(dbh);
  const tag = flag('tag');
  let rows = [];
  for (const u of users) rows = rows.concat(dbStore.listRepos(dbh, u.id, { tag, limit: numFlag('limit', 50) }));
  if (args.flags.json) console.log(asJson(rows));
  else {
    console.log(c.head(`▎repos${tag ? ` tagged ${c.accent(tag)}` : ''}`));
    for (const r of rows) {
      console.log(`  ${c.bold(r.full_name.padEnd(40))} ${r.language ? c.accent(r.language.padEnd(12)) : ''.padEnd(12)} ${c.muted(compact(r.stars) + '★')} ${c.muted(ago(r.last_pushed_at))} ${r.is_fork ? c.muted('(fork)') : ''}`);
    }
  }
  dbh.close();
}

function cmdCommits() {
  const { dbh } = openStore();
  const rows = dbStore.listCommits(dbh, {
    repoFullName: flag('repo'), limit: numFlag('limit', 30), since: flag('since'),
  });
  if (args.flags.json) console.log(asJson(rows));
  else {
    console.log(c.head('▎recent commits'));
    for (const cmt of rows) {
      const prefix = cmt.message_prefix ? c.accent(cmt.message_prefix + ':') : '';
      console.log(`  ${c.muted((cmt.day || '????').padEnd(11))} ${c.muted(cmt.sha.slice(0, 8))} ${prefix.padEnd(0)} ${(cmt.message || '').split('\n')[0].slice(0, 86)}`);
    }
  }
  dbh.close();
}

function cmdRoute() {
  const tag = flag('query');
  if (!tag) { console.error('usage: memory route <tag>'); process.exit(2); }
  const { dbh } = openStore();
  const res = memory.route(dbh, tag, { limit: numFlag('limit', 10) });
  if (args.flags.json) console.log(asJson(res));
  else {
    console.log(c.head(`▎route: ${c.accent(res.tag)}`));
    if (!res.repos.length) { console.log(`  ${c.muted('no asset routed to this tag yet.')}`); }
    for (const r of res.repos) {
      console.log(`\n  ${c.bold(r.full_name)} ${c.muted(`★${compact(r.stars)} · ${r.features.activity_tier} · branch ${r.default_branch}`)}`);
      if (r.description) console.log(`    ${c.muted(r.description)}`);
      const feats = Object.entries(r.features)
        .filter(([k]) => !['activity_tier', 'default_branch'].includes(k))
        .map(([k, v]) => `${k}=${v}`).join(' ');
      if (feats) console.log(`    ${c.muted(feats)}`);
      console.log(`    ${c.muted('entry →')} ${r.url}`);
    }
    if (res.recent_commits.length) {
      console.log(`\n  ${c.bold('recent commits here')}`);
      for (const cmt of res.recent_commits.slice(0, 8)) {
        console.log(`    ${c.muted((cmt.day || '').padEnd(11))} ${cmt.sha} ${(cmt.message || '').split('\n')[0].slice(0, 80)}`);
      }
    }
    if (res.related_tags.length) {
      console.log(`\n  ${c.bold('neighborhood:')} ${res.related_tags.map((t) => `${c.accent(t.tag)} ${c.muted(`×${t.shared_repos}`)}`).join('  ')}`);
    }
  }
  dbh.close();
}

function cmdGraph() {
  const tag = flag('query');
  if (!tag) { console.error('usage: memory graph <tag>'); process.exit(2); }
  const { dbh } = openStore();
  const res = memory.tagGraph(dbh, tag, { limit: numFlag('limit', 10) });
  if (args.flags.json) console.log(asJson(res));
  else {
    console.log(c.head(`▎graph: ${c.accent(res.tag)} ${c.muted(`(${res.repo_count} repos · weight ${res.weight})`)}`));
    if (!res.neighbors.length) console.log(`  ${c.muted('no neighbors — is this tag synced?')}`);
    for (const n of res.neighbors) console.log(`  ${c.accent(n.tag.padEnd(16))} ${c.muted(n.kind.padEnd(9))} shared with ${n.shared_repos} repos`);
  }
  dbh.close();
}

function cmdStats() {
  const { dbh, path } = openStore();
  const res = memory.stats(dbh);
  if (args.flags.json) console.log(asJson({ ...res, db_path: path }));
  else {
    console.log(c.head('▎memory stats'));
    console.log(`  store: ${c.muted(path)}`);
    console.log(`  users ${res.user_count} · repos ${res.repos} · commits ${res.commits}`);
    console.log(`  tags ${res.tags} · tag edges ${res.edges} · features ${res.features} · index docs ${res.index_size}`);
    for (const u of res.users) {
      const f = u.frequency;
      console.log(`\n  ${c.bold(u.login)} ${c.muted(`synced ${ago(u.synced_at)}`)}`);
      console.log(`    commits ${f.total_commits} across ${f.active_days} days · longest streak ${f.longest_streak}d · ${f.commits_per_active_day}/day`);
      if (f.peak_hour) console.log(`    peak hour ${String(f.peak_hour.hour).padStart(2, '0')}:00 (${f.peak_hour.count} commits)`);
      console.log(`    ${c.muted('tags:')} ${u.top_tags.join('  ')}`);
    }
    if (res.top_languages.length) {
      console.log(`\n  top languages: ${res.top_languages.map((l) => `${c.accent(l.language)} ${l.n}`).join('  ')}`);
    }
  }
  dbh.close();
}

function printVersion() { console.log(`dev-agent-memory v${VERSION}`); }

function printHelp() {
  console.log(`
${c.head('dev-agent-memory')} ${c.muted(`v${VERSION}`)} — local asset routing & memory graph

${c.bold('USAGE')}
  memory sync <login>          fetch profile + repos + recent commits into local SQLite
  memory find <query>          hybrid search: tags + full-text over your memory
  memory user [login]          show remembered profile, tags and commit frequency
  memory tags                  list the tech-stack vocabulary (languages/topics/licenses)
  memory repos [--tag t]       list synced repositories
  memory commits [--repo o/n]  list remembered commits
  memory route <tag>           asset-routing card for a technology
  memory graph <tag>           tag neighborhood in the memory graph
  memory stats                 database + frequency stats

${c.bold('SYNC OPTIONS')}
  --repos N        max repositories         (default 100)
  --commits N      max commits stored       (default 500)
  --deep N         fetch language byte-maps for top-N active repos (default 3; --no-deep disables)

${c.bold('GLOBAL OPTIONS')}
  --db <path>      SQLite store location    (env DEV_MEMORY_DB; default ~/.dev-agent-memory/memory.db)
  --api <url>      GitHub API base          (env GITHUB_API_BASE; for offline/proxy setups)
  --token <pat>    GitHub token             (env GITHUB_TOKEN; lifts 60 req/h to 5000 req/h)
  --json           machine-readable output
  --quiet          suppress progress lines

${c.bold('EXAMPLES')}
  memory sync torvalds
  memory find 'rust async'
  memory find 'fix: deadlock' --kind commit
  memory route rust
  memory graph python
  memory stats --json
`);
}
