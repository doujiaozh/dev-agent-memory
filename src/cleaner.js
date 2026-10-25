// Data cleaning: turn raw GitHub payloads into normalized, query-friendly values.
// Keeping this isolated makes the memory layer deterministic and easy to test.

const CONV_PREFIX_RE =
  /^(merge|feat|feature|fix|hotfix|docs|doc|style|refactor|perf|performance|test|tests|build|ci|chore|revert|release|wip|security|deps)\b/i;

/** Collapse whitespace/newlines; drop control chars; empty -> null. */
export function squashText(raw) {
  if (raw == null) return null;
  const s = String(raw)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return s || null;
}

const TRAILER_RE = /^([a-z0-9-]+(?:-[a-z0-9]+)*:|Reviewed-by|Signed-off-by|Co-authored-by|Co-authored|on behalf of)\b/im;

/**
 * Clean a raw commit message:
 *  - squash whitespace, strip PGP-signature blocks and noisy trailers
 *  - always returns { headline, body, clean }
 * `clean` is what we store (headline + trimmed body, capped for storage).
 */
export function cleanCommitMessage(raw) {
  const squashed = squashText(raw);
  if (!squashed) return { headline: null, body: null, clean: null };
  let text = squashed.replace(/-----BEGIN PGP SIGNATURE-----[\s\S]*?-----END PGP SIGNATURE-----/g, ' ');
  // Drop trailing "Co-authored-by:" / "Signed-off-by:" blocks from the body tail.
  const lines = text.split('\n');
  while (lines.length > 1) {
    const last = lines[lines.length - 1].trim();
    if (last === '' || TRAILER_RE.test(last)) lines.pop();
    else break;
  }
  text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const firstNl = text.indexOf('\n');
  const headline = firstNl === -1 ? text : text.slice(0, firstNl);
  const body = firstNl === -1 ? null : text.slice(firstNl + 1).trim() || null;
  return {
    headline: headline.length > 300 ? headline.slice(0, 297) + '...' : headline,
    body,
    clean: text.length > 2000 ? text.slice(0, 1997) + '...' : text,
  };
}

/** Classify a commit message: conventional-commit type, or merge/docs heuristic. */
export function classifyMessage(rawOrClean) {
  const msg = String(rawOrClean || '');
  if (!msg) return null;
  const first = msg.split('\n')[0];
  const m = first.match(CONV_PREFIX_RE);
  if (m) return canonicalPrefix(m[1].toLowerCase());
  if (/^merge\b|^merged?\s+(pull|branch|remote)/i.test(first)) return 'merge';
  if (/^readme|^docs?\b|\.md\b/i.test(first) && !m) return 'docs';
  if (/^version|^bump|^release v/i.test(first)) return 'release';
  return null;
}

function canonicalPrefix(p) {
  const map = { feature: 'feat', doc: 'docs', performance: 'perf', tests: 'test', hotfix: 'fix' };
  return map[p] || p;
}

/** Normalize a tech tag: lowercase, single spaces, trimmed. */
export function normalizeTag(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Normalize a programming language name for tags (keeps case-sensitive forms like C++/C#). */
export function normalizeLanguage(lang) {
  const s = String(lang ?? '').trim();
  if (!s) return null;
  // Language aliases GitHub users commonly mix (matched on the space-stripped key).
  const alias = {
    'c++': 'c++', 'c#': 'c#', 'f#': 'f#', 'objective-c': 'objective-c',
    'jupyternotebook': 'jupyter-notebook', 'html': 'html', 'shaderlab': 'shaderlab',
  };
  const key = s.toLowerCase().replace(/\s+/g, '');
  if (alias[key]) return alias[key];
  if (key.includes('+') || key.includes('#')) return s;
  // Keep GitHub's display case ("Rust", "TypeScript", "Visual Basic"); only
  // noisy input is normalized: SHOUTING -> lowercase, lowercase stays as-is.
  if (s.length >= 2 && s === s.toUpperCase()) return key;
  if (!/[A-Z]/.test(s)) return key;
  return s;
}

/** Clean a repo/user description. */
export function cleanDescription(raw) {
  const s = squashText(raw);
  return s && s.length > 500 ? s.slice(0, 497) + '...' : s;
}

/** ISO date -> 'YYYY-MM-DD' (or null). */
export function dayOf(iso) {
  if (!iso) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso));
  return m ? m[1] : null;
}

/** ISO date -> commit hour 0-23 in *local* time of the machine (commit-frequency kernel). */
export function hourOf(iso) {
  if (!iso) return null;
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return null;
  return d.getHours();
}

/** ISO date -> ISO week label 'YYYY-Www' (Kotlin-style 2026-W43). */
export function weekOf(iso) {
  if (!iso) return null;
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return null;
  const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (4 - (d.getDay() || 7)));
  const week1 = new Date(thursday.getFullYear(), 0, 4);
  const week = 1 + Math.round(
    ((thursday - week1) / 86400000 - 3 + ((week1.getDay() || 7) - 1)) / 7);
  return `${thursday.getFullYear()}-W${String(week).padStart(2, '0')}`;
}
