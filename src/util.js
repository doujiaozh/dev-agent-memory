// Small shared utilities: paths, logging, timing helpers.
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const VERSION = '0.1.0';

/** Resolve the SQLite store location. Priority: DEV_MEMORY_DB env > ~/.dev-agent-memory/memory.db */
export function defaultDbPath() {
  const env = process.env.DEV_MEMORY_DB;
  if (env && env.trim()) return resolve(env);
  return join(homedir(), '.dev-agent-memory', 'memory.db');
}

/** Make sure the parent directory of a file exists. */
export function ensureDirFor(file) {
  const dir = dirname(resolve(file));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel = LEVELS[process.env.DEV_MEMORY_LOG?.toLowerCase()] ?? LEVELS.info;

/** Tiny stderr logger. stdout is reserved for data output (human text / --json). */
export const log = {
  setLevel: (lvl) => { minLevel = LEVELS[lvl] ?? minLevel; },
  debug: (msg, ...rest) => emit('debug', msg, rest),
  info: (msg, ...rest) => emit('info', msg, rest),
  warn: (msg, ...rest) => emit('warn', msg, rest),
  error: (msg, ...rest) => emit('error', msg, rest),
};

function emit(level, msg, rest) {
  if (LEVELS[level] < minLevel) return;
  const prefix = level === 'info' ? '' : `[${level}] `;
  if (rest.length) console.error(prefix + msg, ...rest);
  else console.error(prefix + msg);
}

/** Human-readable "x days ago" from an ISO timestamp. */
export function ago(iso, now = new Date()) {
  if (!iso) return '—';
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  return `${Math.floor(mon / 12)}y ago`;
}

/** Comma-grouping for numbers, e.g. 45000 -> "45,000". */
export function num(n) {
  return Number(n ?? 0).toLocaleString('en-US');
}

/** Compact number, e.g. 45000 -> "45.0k". */
export function compact(n) {
  const v = Number(n ?? 0);
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(1)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
}
