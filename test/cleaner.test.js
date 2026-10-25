import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanCommitMessage, cleanDescription, classifyMessage, dayOf, hourOf,
  normalizeLanguage, normalizeTag, squashText, weekOf,
} from '../src/cleaner.js';

describe('squashText', () => {
  test('collapses whitespace and drops control chars', () => {
    assert.equal(squashText('  a\t\tb   c  '), 'a b c');
    assert.equal(squashText('a\n\n\n\nb'), 'a\nb');
    assert.equal(squashText('no\x07control\x00chars'), 'no control chars');
  });
  test('null / empty -> null', () => {
    assert.equal(squashText(null), null);
    assert.equal(squashText('   \n  '), null);
  });
});

describe('cleanCommitMessage', () => {
  test('strips PGP signature block', () => {
    const { clean, headline } = cleanCommitMessage(
      'perf: avoid false sharing\n\nBenchmark: +9%.\n\n-----BEGIN PGP SIGNATURE-----\nwsBcBAAB\n-----END PGP SIGNATURE-----');
    assert.equal(headline, 'perf: avoid false sharing');
    assert.ok(!clean.includes('PGP'));
    assert.ok(!clean.includes('wsBcBAAB'));
  });
  test('strips co-authored / signed-off trailers', () => {
    const { clean } = cleanCommitMessage(
      'feat(queue): ring buffer\n\nReduces contention.\n\nCo-authored-by: Friend <f@x.io>\nSigned-off-by: Demo <d@x.io>');
    assert.ok(!clean.includes('Co-authored-by'));
    assert.ok(!clean.includes('Signed-off-by'));
    assert.ok(clean.includes('Reduces contention.'));
  });
  test('empty message yields nulls', () => {
    assert.deepEqual(cleanCommitMessage('   '), { headline: null, body: null, clean: null });
  });
  test('caps oversized messages', () => {
    const { clean, headline } = cleanCommitMessage('x'.repeat(5000));
    assert.ok(clean.length <= 2000);
    assert.ok(headline.length <= 300);
    assert.ok(clean.endsWith('...'));
  });
  test('single-line message has no body', () => {
    const r = cleanCommitMessage('fix: wake consumers');
    assert.equal(r.headline, 'fix: wake consumers');
    assert.equal(r.body, null);
    assert.equal(r.clean, 'fix: wake consumers');
  });
});

describe('classifyMessage', () => {
  test('conventional prefixes canonicalize', () => {
    assert.equal(classifyMessage('feat: x'), 'feat');
    assert.equal(classifyMessage('feature: x'), 'feat');
    assert.equal(classifyMessage('doc: x'), 'docs');
    assert.equal(classifyMessage('performance: x'), 'perf');
    assert.equal(classifyMessage('hotfix: x'), 'fix');
    assert.equal(classifyMessage('tests: x'), 'test');
  });
  test('merge / release heuristics', () => {
    assert.equal(classifyMessage('Merge pull request #42 from x/y'), 'merge');
    assert.equal(classifyMessage('merge branch z'), 'merge');
    assert.equal(classifyMessage('release v1.2.3'), 'release');
    assert.equal(classifyMessage('bump numpy to 2.x'), 'release');
  });
  test('unknown prefix -> null', () => {
    assert.equal(classifyMessage('add fish prompt'), null);
    assert.equal(classifyMessage(''), null);
  });
});

describe('normalizers', () => {
  test('normalizeTag lowercases', () => {
    assert.equal(normalizeTag('  Rust  '), 'rust');
    assert.equal(normalizeTag('Jupyter  Notebook'), 'jupyter notebook');
  });
  test('normalizeLanguage keeps case-sensitive forms', () => {
    assert.equal(normalizeLanguage('C++'), 'c++');
    assert.equal(normalizeLanguage('C#'), 'c#');
    assert.equal(normalizeLanguage('Jupyter Notebook'), 'jupyter-notebook');
    // GitHub's display case is preserved for ordinary languages...
    assert.equal(normalizeLanguage('Rust'), 'Rust');
    assert.equal(normalizeLanguage('TypeScript'), 'TypeScript');
    // ...while genuinely noisy casing is normalized to lowercase.
    assert.equal(normalizeLanguage('rust'), 'rust');
    assert.equal(normalizeLanguage('RUST'), 'rust');
    assert.equal(normalizeLanguage(''), null);
  });
  test('cleanDescription truncates at 500', () => {
    assert.equal(cleanDescription('  spaced  out  '), 'spaced out');
    assert.ok(cleanDescription('y'.repeat(800)).length <= 500);
  });
});

describe('time helpers', () => {
  test('dayOf takes the date part', () => {
    assert.equal(dayOf('2026-10-25T10:41:53+08:00'), '2026-10-25');
    assert.equal(dayOf(null), null);
  });
  test('hourOf is 0-23', () => {
    const h = hourOf('2026-10-25T10:41:53Z');
    assert.ok(Number.isInteger(h) && h >= 0 && h <= 23);
    assert.equal(hourOf('not-a-date'), null);
  });
  test('weekOf is ISO YYYY-Www', () => {
    assert.equal(weekOf('2026-01-01T00:00:00Z'), '2026-W01');
    assert.match(weekOf('2026-10-25T12:00:00Z'), /^2026-W\d{2}$/);
  });
});
