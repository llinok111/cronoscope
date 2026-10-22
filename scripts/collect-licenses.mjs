/**
 * Collect licence obligations for everything the tool actually ships.
 *
 * MIT (and BSD/Apache) obligations are the same shape: keep the copyright
 * notice and the permission text with every copy. This script walks the runtime
 * dependency closure, copies each licence verbatim into third_party/<name>/,
 * records a hash so drift is visible, and regenerates THIRD_PARTY_NOTICES.md
 * from the files rather than from anything typed by hand.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const pkg = readJson(join(root, 'package.json'));
const LICENSE_CANDIDATES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE', 'LICENSE-MIT', 'COPYING'];

function packageDir(name) {
  return join(root, 'node_modules', ...name.split('/'));
}

/** Runtime closure: direct dependencies plus everything they depend on. */
function runtimeClosure(roots) {
  const seen = new Map();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const dir = packageDir(name);
    if (!existsSync(dir)) continue;
    const meta = readJson(join(dir, 'package.json'));
    seen.set(name, { dir, meta });
    for (const dep of Object.keys(meta.dependencies ?? {})) queue.push(dep);
    for (const dep of Object.keys(meta.optionalDependencies ?? {})) queue.push(dep);
    for (const dep of Object.keys(meta.peerDependencies ?? {})) {
      if (existsSync(packageDir(dep))) queue.push(dep);
    }
  }
  return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

const closure = runtimeClosure(Object.keys(pkg.dependencies ?? {}));
const index = [];

for (const [name, { dir, meta }] of closure) {
  const licenseFile = LICENSE_CANDIDATES.map((f) => join(dir, f)).find((p) => existsSync(p));
  if (!licenseFile) {
    console.error(`MISSING LICENCE FILE: ${name}@${meta.version}`);
    process.exitCode = 1;
    continue;
  }
  const text = readFileSync(licenseFile, 'utf8');
  const target = join(root, 'third_party', name);
  mkdirSync(target, { recursive: true });
  const outName = licenseFile.endsWith('.md') ? 'LICENSE.md' : 'LICENSE';
  copyFileSync(licenseFile, join(target, outName));

  const copyright = (text.match(/^.*copyright.*$/im)?.[0] ?? '').trim();
  const repository = typeof meta.repository === 'string' ? meta.repository : meta.repository?.url ?? '';
  const source = repository
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '')
    .replace(/^github:/, 'https://github.com/');

  index.push({
    name,
    version: meta.version,
    license: meta.license ?? (text.includes('Apache License') ? 'Apache-2.0' : 'SEE LICENSE'),
    copyright,
    source,
    homepage: meta.homepage ?? null,
    file: `third_party/${name}/${outName}`,
    sha256: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text, 'utf8'),
    requiredBy: Object.entries(Object.fromEntries(closure))
      .filter(([, v]) => Object.keys(v.meta.dependencies ?? {}).includes(name))
      .map(([k]) => (Object.keys(pkg.dependencies).includes(k) ? k : k)),
  });
}

writeFileSync(join(root, 'third_party', 'INDEX.json'), `${JSON.stringify({ generatedFrom: 'npm runtime closure', packages: index }, null, 2)}\n`);

const lines = [];
lines.push('# Third-party notices');
lines.push('');
lines.push(`cronoscope ${pkg.version} bundles and/or depends on the following packages at runtime.`);
lines.push('Each entry is regenerated from the package installed in `node_modules` by `npm run licenses`;');
lines.push('the full licence text is copied verbatim to the path shown and shipped in the ZIP.');
lines.push('');
lines.push('| package | version | licence | file | sha256 (first 16) |');
lines.push('|---|---|---|---|---|');
for (const entry of index) {
  lines.push(`| [${entry.name}](${entry.source || entry.homepage || '#'}) | ${entry.version} | ${entry.license} | \`${entry.file}\` | \`${entry.sha256.slice(0, 16)}\` |`);
}
lines.push('');
for (const entry of index) {
  const text = readFileSync(join(root, entry.file), 'utf8').trimEnd();
  lines.push(`## ${entry.name} ${entry.version}`);
  lines.push('');
  lines.push(`- licence: ${entry.license}`);
  lines.push(`- copyright: ${entry.copyright || '(not stated in the licence file)'}`);
  lines.push(`- source: ${entry.source || entry.homepage || 'see package metadata'}`);
  lines.push(`- reproduced from: \`${entry.file}\``);
  lines.push('');
  lines.push('```text');
  lines.push(text);
  lines.push('```');
  lines.push('');
}
writeFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), `${lines.join('\n')}\n`);

console.log(`collected ${index.length} package licences:`);
for (const entry of index) console.log(`  ${entry.name}@${entry.version}  ${entry.license}  ${entry.bytes}B`);
