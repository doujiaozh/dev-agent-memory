// Derivation: turn cleaned rows into the "memory" facts the AI layer consumes —
//   * tech-stack tags          (repo -> weighted tag set)
//   * core code features       (repo -> key/value traits)
//   * commit frequency buckets (user -> D:/W:/H: aggregates)
//   * user-level tag ranking   (recency x popularity x activity)

import { dayOf, hourOf, normalizeTag, weekOf } from './cleaner.js';

const SIZE_TIERS = [
  [100, 'tiny'], [1_000, 'small'], [10_000, 'medium'], [100_000, 'large'], [1_000_000, 'huge'],
];
const STAR_TIERS = [
  [10, 'seed'], [100, 'niche'], [1_000, 'known'], [10_000, 'popular'], [100_000, 'flagship'],
];

/** Language byte-map -> ranked mix string 'Rust 82%, Python 11%, Shell 7%'. */
export function languageMix(languagesJson) {
  let langs = {};
  try { langs = JSON.parse(languagesJson || '{}'); } catch { /* keep empty */ }
  const total = Object.values(langs).reduce((a, b) => a + Number(b || 0), 0);
  if (total <= 0) return null;
  const ranked = Object.entries(langs)
    .map(([name, bytes]) => [name, Number(bytes)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  return ranked
    .map(([name, bytes], i) => {
      const pct = i === ranked.length - 1
        ? Math.max(0, +(100 - ranked.slice(0, -1).reduce((s, r) => s + (r[1] / total) * 100, 0)).toFixed(1))
        : +((bytes / total) * 100).toFixed(1);
      return `${name} ${pct}%`;
    })
    .join(', ');
}

export function sizeTier(kb) {
  const v = Number(kb ?? 0);
  for (const [max, label] of SIZE_TIERS) if (v < max) return label;
  return 'mega';
}

export function starTier(stars) {
  const v = Number(stars ?? 0);
  for (const [max, label] of STAR_TIERS) if (v < max) return label;
  return 'legendary';
}

const DAY = 86400000;

/** Activity tier from last push: fresh / active / stale / dormant / dead. */
export function activityTier(lastPushedAt, now = new Date()) {
  if (!lastPushedAt) return 'unknown';
  const days = (now.getTime() - new Date(lastPushedAt).getTime()) / DAY;
  if (!Number.isFinite(days)) return 'unknown';
  if (days < 7) return 'fresh';
  if (days < 90) return 'active';
  if (days < 365) return 'stale';
  if (days < 730) return 'dormant';
  return 'dead';
}

/** Weighted tag list for a repo: primary language, language mix, topics, license. */
export function repoTags(repo, { primaryLanguageWeight = 2.0, languageWeight = 1.2, topicWeight = 1.0, licenseWeight = 0.5 } = {}) {
  const tags = [];
  const push = (name, kind, weight) => {
    const n = normalizeTag(name);
    if (n) tags.push({ name: n, kind, weight });
  };
  if (repo.language) push(repo.language, 'language', primaryLanguageWeight);
  let langs = {};
  try { langs = JSON.parse(repo.languages_json || repo._languagesJson || '{}'); } catch { /* ignore */ }
  for (const name of Object.keys(langs)) {
    if (!repo.language || normalizeTag(name) !== normalizeTag(repo.language)) {
      push(name, 'language', languageWeight);
    }
  }
  let topics = [];
  try { topics = JSON.parse(repo.topics_json || repo._topicsJson || '[]'); } catch { /* ignore */ }
  for (const t of topics) push(t, 'topic', topicWeight);
  if (repo.license) push(repo.license, 'license', licenseWeight);
  // Merge duplicates (same name, different kinds) keeping max weight & first kind.
  const byName = new Map();
  for (const t of tags) {
    const prev = byName.get(t.name);
    if (!prev || t.weight > prev.weight) byName.set(t.name, { ...t });
  }
  return [...byName.values()];
}

/** Core code features for a repo — the "what kind of code is this" fingerprint. */
export function repoFeatures(repo, { now = new Date() } = {}) {
  const features = {
    size_tier: sizeTier(repo.size_kb ?? repo.size),
    star_tier: starTier(repo.stars ?? repo.stargazers_count),
    activity_tier: activityTier(repo.last_pushed_at ?? repo.pushed_at, now),
    is_fork: (repo.is_fork != null ? !!repo.is_fork : !!repo.fork) ? 'yes' : 'no',
    is_archived: (repo.is_archived ?? (repo.archived ? 1 : 0)) ? 'yes' : 'no',
    default_branch: repo.default_branch ?? 'main',
    has_topics: (Array.isArray(repo.topics) ? repo.topics.length > 0 : !!repo.topics_json) ? 'yes' : 'no',
  };
  const mix = languageMix(repo.languages_json ?? repo._languagesJson);
  if (mix) features.lang_mix = mix;
  if (repo.license) features.license = repo.license;
  if (repo.open_issues != null) features.open_issues = repo.open_issues;
  return features;
}

/**
 * Aggregate user-level tags from repos + per-repo commit counts.
 * weight = activityScore(recency) * (1 + log10(1+stars)) + commitHits
 */
export function aggregateUserTags(repos, repoCommitCounts = new Map(), { now = new Date() } = {}) {
  const acc = new Map(); // name -> {name, kind, weight, hits}
  for (const repo of repos) {
    const idleDays = repo.last_pushed_at
      ? (now.getTime() - new Date(repo.last_pushed_at).getTime()) / DAY
      : Infinity;
    const activityScore = Number.isFinite(idleDays)
      ? 1 / (1 + idleDays / 120) // half-life ~ 4 months
      : 0.05;
    const popScore = 1 + Math.log10(1 + Number(repo.stars ?? repo.stargazers_count ?? 0));
    const hits = repoCommitCounts.get(repo.full_name) || repoCommitCounts.get(repo.id) || 0;
    const base = activityScore * popScore + hits * 0.25;
    for (const t of repoTags(repo)) {
      const cur = acc.get(t.name);
      if (!cur) acc.set(t.name, { name: t.name, kind: t.kind, weight: base * t.weight, hits });
      else { cur.weight += base * t.weight; cur.hits += hits; }
    }
  }
  return [...acc.values()].map((t) => ({ ...t, weight: +t.weight.toFixed(4) }))
    .sort((a, b) => b.weight - a.weight);
}

/** Build commit-frequency buckets from cleaned commit rows ({day, hour, authoredAt}). */
export function frequencyBuckets(commits) {
  const buckets = new Map();
  const bump = (key) => buckets.set(key, (buckets.get(key) || 0) + 1);
  for (const c of commits) {
    const day = c.day ?? dayOf(c.authoredAt ?? c.authored_at);
    if (day) {
      bump(`D:${day}`);
      bump(`W:${weekOf(day)}`);
    }
    const hour = c.hour ?? hourOf(c.authoredAt ?? c.authored_at);
    if (hour != null) bump(`H:${String(hour).padStart(2, '0')}`);
  }
  return buckets;
}

/**
 * Commit-frequency summary over stored daily buckets:
 * total, active days, streaks (current/longest), commits/day on active days,
 * peak hour, and a recent N-week daily series for sparkline rendering.
 */
export function frequencySummary(dailyBuckets, hourlyBuckets = []) {
  const days = dailyBuckets
    .map(([bucket, count]) => [bucket.slice(2), count])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const total = days.reduce((s, d) => s + d[1], 0);
  let longest = 0, current = 0, run = 0, prev = null;
  for (const [day] of days) {
    if (prev && isNextDay(prev, day)) { run += 1; } else { run = 1; }
    longest = Math.max(longest, run);
    current = run;
    prev = day;
  }
  const hours = hourlyBuckets
    .map(([bucket, count]) => [Number(bucket.slice(2)), count])
    .sort((a, b) => b[1] - a[1]);
  const peakHour = hours.length ? hours[0] : null;
  return {
    total_commits: total,
    active_days: days.length,
    longest_streak: longest,
    current_streak: current,
    commits_per_active_day: days.length ? +(total / days.length).toFixed(2) : 0,
    peak_hour: peakHour ? { hour: peakHour[0], count: peakHour[1] } : null,
    daily: days,
  };
}

function isNextDay(prev, next) {
  const a = new Date(prev + 'T00:00:00'), b = new Date(next + 'T00:00:00');
  return Math.round((b - a) / DAY) === 1;
}
