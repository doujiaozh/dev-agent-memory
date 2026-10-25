import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  activityTier, aggregateUserTags, frequencyBuckets, frequencySummary,
  languageMix, repoFeatures, repoTags, sizeTier, starTier,
} from '../src/derive.js';

const NOW = new Date('2026-10-25T12:00:00Z');
const pushed = (daysAgo) => new Date(NOW.getTime() - daysAgo * 86400000).toISOString();

describe('tiers', () => {
  test('sizeTier boundaries', () => {
    assert.equal(sizeTier(0), 'tiny');
    assert.equal(sizeTier(99), 'tiny');
    assert.equal(sizeTier(100), 'small');
    assert.equal(sizeTier(999), 'small');
    assert.equal(sizeTier(1000), 'medium');
    assert.equal(sizeTier(9999), 'medium');
    assert.equal(sizeTier(10_000), 'large');
    assert.equal(sizeTier(99_999), 'large');
    assert.equal(sizeTier(100_000), 'huge');
    assert.equal(sizeTier(999_999), 'huge');
    assert.equal(sizeTier(1_000_000), 'mega');
    assert.equal(sizeTier(2_000_000), 'mega');
  });
  test('starTier boundaries', () => {
    assert.equal(starTier(0), 'seed');
    assert.equal(starTier(10), 'niche');
    assert.equal(starTier(134), 'known');
    assert.equal(starTier(1000), 'popular');
    assert.equal(starTier(9999), 'popular');
    assert.equal(starTier(10_000), 'flagship');
    assert.equal(starTier(12_000), 'flagship');
    assert.equal(starTier(100_000), 'legendary');
    assert.equal(starTier(500_000), 'legendary');
  });
  test('activityTier recency bands', () => {
    assert.equal(activityTier(pushed(1), NOW), 'fresh');
    assert.equal(activityTier(pushed(30), NOW), 'active');
    assert.equal(activityTier(pushed(200), NOW), 'stale');
    assert.equal(activityTier(pushed(500), NOW), 'dormant');
    assert.equal(activityTier(pushed(900), NOW), 'dead');
    assert.equal(activityTier(null), 'unknown');
  });
});

describe('languageMix', () => {
  test('percentages sum to ~100 with rounding on the last entry', () => {
    const mix = languageMix(JSON.stringify({ Rust: 41000, Shell: 900, Makefile: 800 }));
    const pcts = mix.match(/\d+(?:\.\d+)?(?=%)/g).map(Number);
    assert.ok(Math.abs(pcts.reduce((a, b) => a + b, 0) - 100) < 0.5, mix);
    assert.ok(mix.startsWith('Rust '));
  });
  test('null for empty input', () => {
    assert.equal(languageMix(null), null);
    assert.equal(languageMix('{}'), null);
  });
});

describe('repoTags', () => {
  const repo = {
    language: 'Rust',
    _languagesJson: JSON.stringify({ Rust: 41000, Shell: 900, Makefile: 800 }),
    _topicsJson: JSON.stringify(['rust', 'concurrency', 'lock-free']),
    license: 'MIT',
  };
  test('primary language gets the top weight, others less', () => {
    const tags = repoTags(repo);
    const byName = Object.fromEntries(tags.map((t) => [t.name, t.weight]));
    assert.equal(byName.rust, 2.0);
    assert.equal(byName.shell, 1.2);
    assert.equal(byName['lock-free'], 1.0);
    assert.equal(byName.mit, 0.5);
  });
  test('kinds are labeled', () => {
    const kinds = Object.fromEntries(repoTags(repo).map((t) => [t.name, t.kind]));
    assert.equal(kinds.rust, 'language');
    assert.equal(kinds.concurrency, 'topic');
    assert.equal(kinds.mit, 'license');
  });
  test('topic + language name collisions merge to the max weight', () => {
    const tags = repoTags({ language: 'Go', _topicsJson: JSON.stringify(['go']) });
    assert.equal(tags.length, 1);
    assert.equal(tags[0].weight, 2.0);
  });
});

describe('repoFeatures', () => {
  test('raw payload and stored row shapes both work', () => {
    const fromPayload = repoFeatures({
      fork: true, archived: false, size: 500, stargazers_count: 1340,
      pushed_at: pushed(2), default_branch: 'main', topics: ['rust'],
      license: 'MIT', open_issues: 21, _languagesJson: JSON.stringify({ Rust: 41000 }),
    }, { now: NOW });
    assert.equal(fromPayload.is_fork, 'yes');
    assert.equal(fromPayload.is_archived, 'no');
    assert.equal(fromPayload.size_tier, 'small');
    assert.equal(fromPayload.star_tier, 'popular');
    assert.equal(fromPayload.activity_tier, 'fresh');
    assert.equal(fromPayload.license, 'MIT');
    assert.equal(fromPayload.open_issues, 21);
    assert.match(fromPayload.lang_mix, /^Rust 100%/);

    const fromRow = repoFeatures({
      is_fork: 0, is_archived: 1, size_kb: 3200, stars: 5,
      last_pushed_at: pushed(400), default_branch: 'master', topics_json: '[]',
      languages_json: null,
    }, { now: NOW });
    assert.equal(fromRow.is_fork, 'no');
    assert.equal(fromRow.is_archived, 'yes');
    assert.equal(fromRow.activity_tier, 'dormant');
    assert.equal('lang_mix' in fromRow, false);
  });
});

describe('aggregateUserTags', () => {
  test('weights recency x popularity and adds commit hits', () => {
    const repos = [
      { full_name: 'a/rust-queue', language: 'Rust', stars: 1340, last_pushed_at: pushed(1), topics_json: '[]', languages_json: '{}' },
      { full_name: 'b/dotfiles', language: 'Shell', stars: 3, last_pushed_at: pushed(400), topics_json: '[]', languages_json: '{}' },
    ];
    const tags = aggregateUserTags(repos, new Map([['a/rust-queue', 4]]), { now: NOW });
    const byName = Object.fromEntries(tags.map((t) => [t.name, t.weight]));
    // active repo: activityScore ~ 1/(1+1/120) = 0.992, popScore ~ 4.13, hits 4x0.25, lang weight 2.0
    assert.ok(byName.rust > byName.shell * 10, `rust=${byName.rust} shell=${byName.shell}`);
    assert.ok(byName.rust > 9.5 && byName.rust < 11, `rust=${byName.rust}`);
    assert.equal(tags[0].name, 'rust'); // sorted desc
  });
  test('missing push date gets a floor score', () => {
    const tags = aggregateUserTags(
      [{ full_name: 'x/y', language: 'Go', stars: 0, last_pushed_at: null, topics_json: '[]', languages_json: '{}' }],
      new Map(), { now: NOW });
    assert.equal(tags[0].weight, +(0.05 * 2.0).toFixed(4));
  });
});

describe('frequency buckets & summary', () => {
  const commits = [
    { day: '2026-10-20', hour: 9, authoredAt: '2026-10-20T09:00:00Z' },
    { day: '2026-10-21', hour: 23, authoredAt: '2026-10-21T23:00:00Z' },
    { day: '2026-10-21', hour: 9, authoredAt: '2026-10-21T09:00:00Z' },
    { day: '2026-10-24', hour: 14, authoredAt: '2026-10-24T14:00:00Z' },
  ];
  test('buckets keyed D:/W:/H:', () => {
    const b = frequencyBuckets(commits);
    assert.equal(b.get('D:2026-10-21'), 2);
    assert.equal(b.get('D:2026-10-20'), 1);
    assert.ok(b.has('W:2026-W43'));
    assert.equal(b.get('H:09'), 2);
    assert.equal(b.get('H:23'), 1);
  });
  test('summary computes streaks and peak hour', () => {
    const s = frequencySummary(
      [['D:2026-10-20', 1], ['D:2026-10-21', 2], ['D:2026-10-24', 1]],
      [['H:09', 2], ['H:23', 1]]);
    assert.equal(s.total_commits, 4);
    assert.equal(s.active_days, 3);
    assert.equal(s.longest_streak, 2);
    assert.equal(s.current_streak, 1);
    assert.equal(s.commits_per_active_day, 1.33);
    assert.deepEqual(s.peak_hour, { hour: 9, count: 2 });
    assert.equal(s.daily.length, 3);
  });
  test('summary on empty input', () => {
    const s = frequencySummary([], []);
    assert.equal(s.total_commits, 0);
    assert.equal(s.peak_hour, null);
    assert.equal(s.longest_streak, 0);
  });
});
