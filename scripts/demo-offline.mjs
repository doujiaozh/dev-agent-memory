#!/usr/bin/env node
/**
 * Offline demo: spins up the mock api.github.com, runs the memory CLI end to
 * end (sync -> find -> route -> tags -> stats), then tears the server down.
 * Usage: node scripts/demo-offline.mjs [--db path]
 */
import { startServer } from '../test/mock-server.js';
import { execFileSync } from 'node:child_process';
import { unlinkSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const dbIdx = argv.indexOf('--db');
const db = dbIdx >= 0 ? argv[dbIdx + 1] : './.tmp-demo-memory.db';

const cli = (cmd) =>
  execFileSync(process.execPath, ['bin/cli.js', ...cmd, '--db', db], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

if (existsSync(db)) unlinkSync(db);
for (const ext of ['-wal', '-shm']) {
  if (existsSync(db + ext)) unlinkSync(db + ext);
}

const { close, baseUrl } = await startServer();
try {
  console.log('=== $ memory sync demodev (against mock api.github.com) ===');
  console.log(cli(['sync', 'demodev', '--api', baseUrl]));
  for (const [label, cmd] of [
    ['=== $ memory find rust ===', ['find', 'rust']],
    ['=== $ memory route rust ===', ['route', 'rust']],
    ['=== $ memory tags ===', ['tags']],
    ['=== $ memory stats ===', ['stats']],
  ]) {
    console.log(label);
    console.log(cli(cmd));
  }
} finally {
  close();
}
console.log(`\n(demo database kept at ${db} — inspect with: node bin/cli.js commits --db ${db})`);
