#!/usr/bin/env node
/**
 * Preflight prints an EXTERNAL readiness template; it never marks a gate passed.
 * --check-run authenticates a prior dry-run's origin before workflow download.
 * --publish validates the external attestation and exact assets before any gh call.
 * The protected release environment/reviewer is the trust boundary, not JSON alone.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repository = 'boyeesu/murmur';
const gates = ['tests', 'package', 'nativeAdapters', 'liveAcceptance', 'platformMatrix', 'dependencyAudit', 'review'];
const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const execute = promisify(execFile);
const run = (command, args) => execute(command, args, { cwd: root, timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
const flags = new Map();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (!['--tag', '--assets', '--readiness', '--notes', '--publish', '--candidate-run', '--check-run'].includes(key) || flags.has(key)) throw new Error('Invalid or duplicate release option');
  if (key === '--publish') flags.set(key, true);
  else {
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing release option');
    flags.set(key, value);
  }
}
if (flags.has('--check-run') && [...flags.keys()].some(key => !['--check-run', '--tag'].includes(key))) throw new Error('--check-run accepts only --tag');
if (!flags.has('--publish') && (flags.has('--readiness') || flags.has('--notes'))) throw new Error('Readiness and notes require --publish');
const candidateRun = flags.get('--check-run') ?? flags.get('--candidate-run') ?? null;
if (candidateRun !== null && !/^[1-9]\d{0,15}$/.test(candidateRun)) throw new Error('Candidate run must be a positive decimal run ID');
const pkg = JSON.parse(await readFile(path.join(root, 'packages/murmur/package.json'), 'utf8'));
const workspace = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const tag = flags.get('--tag') ?? `v${pkg.version}`;
const prerelease = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)$/;
const match = typeof pkg.version === 'string' && pkg.version.match(prerelease);
if (pkg.name !== 'murmur-local' || workspace.version !== pkg.version || tag !== `v${pkg.version}` || !match || match[4].split('.').some(part => /^0\d+$/.test(part))) {
  throw new Error('Only a prerelease tag exactly matching both package versions is supported');
}
const head = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('Expected an exact SHA-1 checkout');
if ((await run('git', ['status', '--porcelain', '--untracked-files=all'])).stdout.trim()) throw new Error('Release tooling requires a clean exact tested checkout');
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== head) throw new Error('Checkout does not match the workflow commit');
if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== repository) throw new Error('Unexpected workflow repository');

async function checkSource() {
  const api = async route => JSON.parse((await run('gh', ['api', `repos/${repository}/${route}`])).stdout);
  const source = await api(`actions/runs/${candidateRun}`);
  if (String(source.id) !== candidateRun || source.repository?.full_name !== repository || source.head_repository?.full_name !== repository ||
      source.head_sha !== head || source.path !== '.github/workflows/prerelease.yml' || source.event !== 'workflow_dispatch' ||
      source.status !== 'completed' || source.conclusion !== 'success' || source.run_attempt !== 1) {
    throw new Error('Candidate must be a successful first-attempt manual run of this workflow, repository and exact commit');
  }
  const result = await api(`actions/runs/${candidateRun}/artifacts?per_page=100`);
  const assets = result.artifacts?.filter(artifact => artifact.name === 'murmur-prerelease-assets');
  if (!Number.isInteger(result.total_count) || result.total_count > 100 || assets?.length !== 1) throw new Error('Expected one unambiguous candidate artifact');
  const artifact = assets[0];
  if (!Number.isSafeInteger(artifact.id) || artifact.id <= 0 || artifact.expired !== false || !(artifact.size_in_bytes > 0) ||
      String(artifact.workflow_run?.id) !== candidateRun || artifact.workflow_run?.head_sha !== head ||
      !Number.isSafeInteger(source.repository?.id) || artifact.workflow_run?.head_repository_id !== source.repository.id) {
    throw new Error('Candidate artifact is expired or does not belong to the trusted source run');
  }
  return { repository, commit: head, candidateRun, artifactId: artifact.id };
}
if (flags.has('--check-run')) {
  console.log(JSON.stringify(await checkSource(), null, 2));
  process.exit(0);
}

const directory = path.resolve(flags.get('--assets') ?? path.join(root, 'dist'));
const base = `${pkg.name}-${pkg.version}`;
const filenames = [`${base}.tgz`, `${base}.tgz.sha256`, `${base}.cdx.json`];
async function regularFile(filename) {
  if (!(await lstat(filename)).isFile()) throw new Error('Release inputs must be regular files, not links');
  return readFile(filename);
}
const contents = await Promise.all(filenames.map(name => regularFile(path.join(directory, name))));
const artifacts = Object.fromEntries(filenames.map((name, i) => [name, { sha256: createHash('sha256').update(contents[i]).digest('hex'), bytes: contents[i].length }]));
const sum = contents[1].toString('utf8').trim().split(/\s+/);
if (sum.length !== 2 || sum[0] !== artifacts[filenames[0]].sha256 || sum[1] !== filenames[0]) throw new Error('Release checksum does not match the exact archive');
// Read only the manifest to stdout; never extract or execute downloaded archive content.
const archiveManifest = JSON.parse((await run('tar', ['-xOzf', path.join(directory, filenames[0]), 'package/package.json'])).stdout);
if (archiveManifest.name !== pkg.name || archiveManifest.version !== pkg.version) throw new Error('Archive package identity/version does not match the checkout');
const bom = JSON.parse(contents[2]);
if (bom.bomFormat !== 'CycloneDX' || !Array.isArray(bom.components) || !bom.components.some(component => component.purl === `pkg:npm/${pkg.name}@${pkg.version}` && component.version === pkg.version)) {
  throw new Error('SBOM must identify the exact package purl and version');
}
const report = {
  schemaVersion: 1, repository, commit: head, tag, version: pkg.version, candidateRun, artifacts,
  releaseReady: false, gates: Object.fromEntries(gates.map(gate => [gate, 'blocked'])),
  reviewedBy: '', evidence: Object.fromEntries(gates.map(gate => [gate, ''])),
};
if (!flags.has('--publish')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}
if (!candidateRun || !flags.has('--readiness') || !flags.has('--notes')) throw new Error('Publication requires an explicit candidate run, external readiness record and release notes');
const readiness = JSON.parse(await regularFile(path.resolve(flags.get('--readiness'))));
for (const field of ['schemaVersion', 'repository', 'commit', 'tag', 'version', 'candidateRun']) {
  if (readiness[field] !== report[field]) throw new Error(`Readiness ${field} does not match this candidate`);
}
if (readiness.releaseReady !== true) throw new Error('Release readiness is not approved');
for (const gate of gates) {
  if (readiness.gates?.[gate] !== 'passed' || typeof readiness.evidence?.[gate] !== 'string' || !readiness.evidence[gate].trim()) throw new Error(`Release gate ${gate} is incomplete or missing evidence`);
}
if (typeof readiness.reviewedBy !== 'string' || !readiness.reviewedBy.trim()) throw new Error('Readiness must identify its reviewer');
if (Object.keys(readiness.artifacts ?? {}).length !== filenames.length || filenames.some(name => readiness.artifacts[name]?.sha256 !== artifacts[name].sha256 || readiness.artifacts[name]?.bytes !== artifacts[name].bytes)) throw new Error('Readiness does not bind the exact release assets');
const notes = path.resolve(flags.get('--notes'));
if (!(await regularFile(notes)).toString('utf8').trim()) throw new Error('Release notes must not be empty');
// All local refusals happen before credentials/network. Recheck source even when
// the workflow already did it before downloading by immutable artifact ID.
const source = await checkSource();
// gh --target is ignored when a tag already exists. Refuse reuse rather than
// accidentally releasing a different commit (or silently moving a public tag).
const refs = JSON.parse((await run('gh', ['api', `repos/${repository}/git/matching-refs/tags/${encodeURIComponent(tag)}`])).stdout);
if (!Array.isArray(refs) || refs.some(ref => ref.ref === `refs/tags/${tag}`)) throw new Error('Release tag already exists or could not be checked; refusing tag reuse');
await run('gh', ['release', 'create', tag, ...filenames.map(name => path.join(directory, name)), '--repo', repository, '--target', head,
  '--prerelease', '--latest=false', '--title', `Murmur ${pkg.version}`, '--notes-file', notes]);
console.log(JSON.stringify({ ...source, tag, artifacts, published: true }, null, 2));
