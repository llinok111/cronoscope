import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { UPSTREAMS, VERSION } from '../src/version.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const index = JSON.parse(read('third_party/INDEX.json'));
const notices = read('THIRD_PARTY_NOTICES.md');

describe('licence obligations', () => {
  it('keeps the advertised version in sync with package.json', () => {
    expect(pkg.version).toBe(VERSION);
  });

  it('pins the upstream versions it advertises', () => {
    for (const [name, version] of Object.entries(UPSTREAMS)) {
      expect(pkg.dependencies[name]).toBe(version);
    }
  });

  it('has a licence copy for every runtime dependency', () => {
    const declared = Object.keys(pkg.dependencies).sort();
    const collected = index.packages.map((p) => p.name).sort();
    expect(collected).toEqual(declared);
    for (const entry of index.packages) {
      expect(existsSync(resolve(root, entry.file)), `${entry.name} licence file`).toBe(true);
      const text = read(entry.file);
      expect(text.length).toBeGreaterThan(200);
      expect(text).toMatch(/Permission is hereby granted|Apache License/i);
    }
  });

  it('records the exact bytes it ships', () => {
    for (const entry of index.packages) {
      const digest = createHash('sha256').update(readFileSync(resolve(root, entry.file))).digest('hex');
      expect(digest).toBe(entry.sha256);
    }
  });

  it('states each copyright holder in the notices file', () => {
    for (const entry of index.packages) {
      expect(notices).toContain(entry.name);
      expect(notices).toContain(entry.version);
      expect(notices).toContain(entry.copyright);
      expect(notices).toContain('Permission is hereby granted');
    }
  });

  it('keeps development-only tooling out of the shipped notices', () => {
    const names = index.packages.map((p) => p.name);
    for (const dev of Object.keys(pkg.devDependencies ?? {})) {
      expect(names).not.toContain(dev);
    }
  });

  it('has its own licence and a NOTICE that scopes the derivative work', () => {
    const license = read('LICENSE');
    expect(license).toContain('MIT License');
    const notice = read('NOTICE');
    expect(notice).toContain('not a fork');
    expect(notice).toContain('cron-parser');
  });

  it('ships no secrets or personal data', () => {
    const files = ['package.json', 'README.md', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'src/index.js'];
    const secretish = /(ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16})/;
    for (const file of files) {
      expect(secretish.test(read(file)), file).toBe(false);
    }
  });
});
