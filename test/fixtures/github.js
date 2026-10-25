// Deterministic offline fixtures mimicking api.github.com payloads for "demodev".
// Dates are generated relative to "now" so frequency assertions stay stable.

const DAY = 86400000;
const now = Date.now();
const iso = (offsetDays, hour = 14) => {
  const d = new Date(now - offsetDays * DAY);
  d.setUTCHours(hour, 17, 42, 0);
  return d.toISOString();
};

export const PROFILE = {
  login: 'demodev',
  id: 424242,
  name: 'Demo Developer',
  company: 'Acme',
  location: 'Shanghai',
  bio: 'polyglot builder · rust + python + go',
  blog: 'https://demodev.dev',
  email: null,
  avatar_url: 'https://avatars.example.com/u/424242',
  html_url: 'https://github.com/demodev',
  public_repos: 6,
  public_gists: 2,
  followers: 128,
  following: 12,
  created_at: '2014-03-11T08:00:00Z',
};

const baseRepo = (over) => ({
  id: Math.floor(Math.random() * 1e9), // overwritten below deterministically
  private: false,
  fork: false,
  archived: false,
  stargazers_count: 0,
  forks_count: 0,
  watchers_count: 1,
  open_issues_count: 0,
  size: 100,
  default_branch: 'main',
  license: null,
  topics: [],
  owner: { login: 'demodev' },
  ...over,
});

export const REPOS = [
  baseRepo({
    id: 101, name: 'rust-queue', full_name: 'demodev/rust-queue',
    description: 'Lock-free   multi-producer queue\n  for Rust  ', language: 'Rust',
    stargazers_count: 1340, forks_count: 88, open_issues_count: 21, size: 3200,
    license: { spdx_id: 'MIT' }, topics: ['rust', 'concurrency', 'queue', 'lock-free'],
    pushed_at: iso(0, 9), created_at: '2021-05-02T10:00:00Z', updated_at: iso(1, 10),
    html_url: 'https://github.com/demodev/rust-queue',
  }),
  baseRepo({
    id: 102, name: 'py-embeddings', full_name: 'demodev/py-embeddings',
    description: 'Vector embeddings kitchen', language: 'Python',
    stargazers_count: 245, forks_count: 12, size: 860,
    license: { spdx_id: 'Apache-2.0' }, topics: ['python', 'embeddings', 'llm'],
    pushed_at: iso(2, 11), created_at: '2022-08-19T10:00:00Z', updated_at: iso(3, 10),
    html_url: 'https://github.com/demodev/py-embeddings',
  }),
  baseRepo({
    id: 103, name: 'go-gate', full_name: 'demodev/go-gate',
    description: 'Tiny API gateway written in Go', language: 'Go',
    stargazers_count: 23, forks_count: 2, size: 210,
    license: { spdx_id: 'BSD-3-Clause' }, topics: ['go', 'gateway', 'http'],
    pushed_at: iso(12, 15), created_at: '2023-01-30T10:00:00Z', updated_at: iso(13, 10),
    html_url: 'https://github.com/demodev/go-gate',
  }),
  baseRepo({
    id: 104, name: 'ts-graph-canvas', full_name: 'demodev/ts-graph-canvas',
    description: 'Interactive graph canvas (typescript, canvas2d)', language: 'TypeScript',
    stargazers_count: 7, size: 1900, pushed_at: iso(45, 20),
    license: { spdx_id: 'MIT' }, topics: ['typescript', 'graph', 'canvas'],
    created_at: '2024-02-14T10:00:00Z', updated_at: iso(46, 10),
    html_url: 'https://github.com/demodev/ts-graph-canvas',
  }),
  baseRepo({
    id: 105, name: 'dotfiles', full_name: 'demodev/dotfiles',
    description: 'my dotfiles', language: 'Shell',
    stargazers_count: 3, size: 42, pushed_at: iso(400, 22),
    created_at: '2015-09-01T10:00:00Z', updated_at: iso(401, 10),
    html_url: 'https://github.com/demodev/dotfiles',
  }),
  baseRepo({
    id: 106, name: 'linux', full_name: 'demodev/linux',
    fork: true, language: 'C', size: 1_400_000,
    stargazers_count: 1, pushed_at: iso(100, 8),
    parent: { full_name: 'torvalds/linux' },
    created_at: '2019-04-01T10:00:00Z', updated_at: iso(100, 10),
    html_url: 'https://github.com/demodev/linux',
  }),
];

export const LANGUAGES = {
  'demodev/rust-queue': { Rust: 41000, Shell: 900, Makefile: 800 },
  'demodev/py-embeddings': { Python: 22000, 'Jupyter Notebook': 3000, Shell: 200 },
  'demodev/go-gate': { Go: 7400, Shell: 150 },
};

const commit = (sha, message, author = { name: 'Demo Developer', email: 'demo@dev.dev' }) => ({
  sha, message, author,
});

export const EVENTS = [
  {
    type: 'PushEvent', created_at: iso(0, 9), id: 'evt-1',
    repo: { name: 'demodev/rust-queue' },
    payload: {
      ref: 'refs/heads/main',
      size: 3,
      commits: [
        commit('a0000000000000000000000000000000000000001',
          'feat(queue): add segmented ring buffer\n\nReduces contention between producers.\n\nCo-authored-by: Friend <f@x.io>'),
        commit('a0000000000000000000000000000000000000002',
          'fix(queue): drain must wake consumers before unlock'),
        commit('a0000000000000000000000000000000000000003',
          'docs: relicense explainer + benchmark table'),
      ],
    },
  },
  {
    type: 'PushEvent', created_at: iso(1, 23), id: 'evt-2',
    repo: { name: 'demodev/rust-queue' },
    payload: {
      ref: 'refs/heads/main', size: 2,
      commits: [
        commit('a0000000000000000000000000000000000000004',
          'perf: avoid false sharing in the tail cursor\n\nBenchmark: +9% p50 throughput.\n\n-----BEGIN PGP SIGNATURE-----\nwsBcBAABCAAQBQJh9...\n-----END PGP SIGNATURE-----'),
        commit('a0000000000000000000000000000000000000005',
          'Merge pull request #42 from demodev/fix-wakeups'),
        // duplicate sha of evt-1's first commit — tests idempotence on re-sync
        commit('a0000000000000000000000000000000000000001',
          'feat(queue): add segmented ring buffer'),
      ],
    },
  },
  {
    type: 'PushEvent', created_at: iso(2, 11), id: 'evt-3',
    repo: { name: 'demodev/py-embeddings' },
    payload: {
      ref: 'refs/heads/main', size: 2,
      commits: [
        commit('b0000000000000000000000000000000000000001',
          'feat(embed): cosine similarity with numpy vectorization'),
        commit('b0000000000000000000000000000000000000002',
          '   \n\nchore: bump numpy to 2.x   '),
      ],
    },
  },
  {
    type: 'PushEvent', created_at: iso(3, 16), id: 'evt-4',
    repo: { name: 'demodev/demoshell' }, // repo not in repos list → null repo_id path
    payload: {
      ref: 'refs/heads/main', size: 1,
      commits: [
        commit('c0000000000000000000000000000000000000001', 'add fish prompt'),
      ],
    },
  },
  {
    type: 'WatchEvent', created_at: iso(4, 12), id: 'evt-5',
    repo: { name: 'demodev/rust-queue' }, payload: { action: 'started' },
  },
  {
    type: 'CreateEvent', created_at: iso(5, 12), id: 'evt-6',
    repo: { name: 'demodev/go-gate' }, payload: { ref_type: 'tag' },
  },
  {
    type: 'PushEvent', created_at: iso(6, 15), id: 'evt-7',
    repo: { name: 'demodev/go-gate' },
    payload: {
      ref: 'refs/heads/main', size: 1,
      commits: [
        commit('d0000000000000000000000000000000000000001', 'fix(gateway): respect X-Forwarded-Proto'),
      ],
    },
  },
];

export const RATE_LIMIT = {
  resources: { core: { limit: 5000, remaining: 4987, reset: 1792897137, used: 13 } },
  rate: { limit: 5000, remaining: 4987, reset: 1792897137, used: 13 },
};
