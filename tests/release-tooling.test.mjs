import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, copyFile, chmod, appendFile, rm, symlink, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { temporary, git } from './helpers.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const version = '0.6.0-alpha.1';
const repository = 'boyeesu/murmur';
const gates = ['tests', 'package', 'nativeAdapters', 'liveAcceptance', 'platformMatrix', 'dependencyAudit', 'review'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (filename, value) => writeFile(filename, JSON.stringify(value, null, 2) + '\n');

// All release invocations run copied scripts in disposable repositories, with
// scrubbed credentials and a fake gh first on PATH. No test can publish a release.
async function fixture(t) {
  const temporaryRoot = await temporary(t);
  const checkout = path.join(temporaryRoot, 'checkout');
  const assets = path.join(temporaryRoot, 'candidate assets');
  const bin = path.join(temporaryRoot, 'bin');
  const home = path.join(temporaryRoot, 'home');
  const stage = path.join(temporaryRoot, 'stage');
  for (const directory of [path.join(checkout, 'scripts'), path.join(checkout, 'packages/murmur'), assets, bin, home, path.join(stage, 'package/dist/cli')]) await mkdir(directory, { recursive: true });
  for (const name of ['release.mjs', 'verify-package.mjs']) await copyFile(path.join(root, 'scripts', name), path.join(checkout, 'scripts', name));
  const manifest = { name: 'murmur-local', version, type: 'module', private: true,
    scripts: { postinstall: 'node -e "throw new Error(\'Lifecycle scripts must not run\')"' } };
  await json(path.join(checkout, 'package.json'), { name: 'murmur-workspace', version, private: true });
  await json(path.join(checkout, 'packages/murmur/package.json'), manifest);
  await writeFile(path.join(stage, 'package/dist/cli/index.js'), 'console.log("murmur --help (isolated candidate fixture)");\n');
  git(checkout, 'init', '-q', '-b', 'main');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-qm', 'Disposable release test fixture\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>');
  const head = git(checkout, 'rev-parse', 'HEAD');
  const filenames = [`murmur-local-${version}.tgz`, `murmur-local-${version}.tgz.sha256`, `murmur-local-${version}.cdx.json`];
  const [archive, checksum, sbom] = filenames.map(name => path.join(assets, name));
  const log = path.join(temporaryRoot, 'gh.jsonl');
  const responses = path.join(temporaryRoot, 'responses.json');
  const notes = path.join(temporaryRoot, 'reviewed release notes.md');
  const readinessFile = path.join(temporaryRoot, 'external-readiness.json');
  const env = { PATH: bin + path.delimiter + process.env.PATH, HOME: home, TMPDIR: temporaryRoot,
    GH_LOG: log, GH_RESPONSES: responses, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  await writeFile(path.join(bin, 'gh'), `#!${process.execPath}\nimport fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) throw new Error('Tests must not inherit credentials');
const responses = JSON.parse(fs.readFileSync(process.env.GH_RESPONSES));
if (args[0] === 'api' && args[1] in responses) console.log(JSON.stringify(responses[args[1]]));
else if (args[0] === 'release' && args[1] === 'create') console.log('fake release; no network');
else { console.error('Unexpected gh call'); process.exitCode = 1; }
`);
  await chmod(path.join(bin, 'gh'), 0o755);
  const sourceRoute = `repos/${repository}/actions/runs/1234`;
  const artifactRoute = sourceRoute + '/artifacts?per_page=100';
  const tagRoute = `repos/${repository}/git/matching-refs/tags/v${version}`;
  const source = { id: 1234, repository: { id: 42, full_name: repository }, head_repository: { full_name: repository },
    head_sha: head, path: '.github/workflows/prerelease.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', run_attempt: 1 };
  const artifact = { id: 5678, name: 'murmur-prerelease-assets', expired: false, size_in_bytes: 123,
    workflow_run: { id: 1234, head_sha: head, head_repository_id: 42 } };
  const saveResponses = () => json(responses, { [sourceRoute]: source, [artifactRoute]: { total_count: 1, artifacts: [artifact] }, [tagRoute]: [] });
  await saveResponses();
  await writeFile(notes, 'Review of this exact candidate.\n');
  async function repack(change = {}) {
    await json(path.join(stage, 'package/package.json'), { ...manifest, ...change });
    await run('tar', ['-czf', archive, '-C', stage, 'package'], { env });
    await writeFile(checksum, `${digest(await readFile(archive))}  ${filenames[0]}\n`);
  }
  await repack();
  const bom = { bomFormat: 'CycloneDX', specVersion: '1.5', components: [{ name: 'murmur', version, purl: `pkg:npm/murmur-local@${version}` }] };
  await json(sbom, bom);
  const invoke = (args = [], extraEnv = {}) => run(process.execPath, [path.join(checkout, 'scripts/release.mjs'), ...args],
    { cwd: checkout, env: { ...env, ...extraEnv }, timeout: 10000, maxBuffer: 1024 * 1024 });
  const preflightArgs = ['--assets', assets, '--candidate-run', '1234'];
  const template = JSON.parse((await invoke(preflightArgs)).stdout);
  const readiness = { ...template, releaseReady: true, reviewedBy: 'fixture-reviewer',
    gates: Object.fromEntries(gates.map(gate => [gate, 'passed'])), evidence: Object.fromEntries(gates.map(gate => [gate, 'Isolated fixture evidence only; not a real release approval.'])) };
  const saveReadiness = () => json(readinessFile, readiness);
  await saveReadiness();
  const publishArgs = ['--publish', ...preflightArgs, '--readiness', readinessFile, '--notes', notes];
  const calls = async () => (await readFile(log, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const refuse = async (pattern, args = publishArgs, extraEnv) => {
    await assert.rejects(invoke(args, extraEnv), error => pattern.test(error.stderr), 'Expected an explicit pre-publication refusal');
    assert.deepEqual(await calls(), [], 'Local refusal must happen before even a gh API/credential call');
  };
  return { temporaryRoot, checkout, assets, stage, archive, checksum, sbom, filenames, notes, readinessFile, env,
    head, source, artifact, saveResponses, sourceRoute, artifactRoute, tagRoute, responses, log, bom, repack,
    invoke, template, readiness, saveReadiness, preflightArgs, publishArgs, calls, refuse };
}

test('preflight returns portable exact-byte bindings and honestly blocked gates without gh', async t => {
  const f = await fixture(t);
  assert.equal(f.template.commit, f.head);
  assert.equal(f.template.repository, repository);
  assert.equal(f.template.tag, `v${version}`);
  assert.equal(f.template.schemaVersion, 1);
  assert.equal(f.template.candidateRun, '1234');
  assert.equal(f.template.releaseReady, false);
  assert.deepEqual(f.template.gates, Object.fromEntries(gates.map(gate => [gate, 'blocked'])));
  for (const name of f.filenames) {
    const bytes = await readFile(path.join(f.assets, name));
    assert.deepEqual(f.template.artifacts[name], { sha256: digest(bytes), bytes: bytes.length });
  }
  assert.equal(JSON.parse((await f.invoke(['--assets', f.assets])).stdout).candidateRun, null);
  assert.deepEqual(await f.calls(), []);
});

test('only complete exact readiness publishes through fake gh to the fixed prerelease target', async t => {
  const f = await fixture(t);
  const result = JSON.parse((await f.invoke(f.publishArgs)).stdout);
  assert.equal(result.published, true);
  assert.equal(result.commit, f.head);
  assert.deepEqual(await f.calls(), [
    ['api', f.sourceRoute], ['api', f.artifactRoute], ['api', f.tagRoute],
    ['release', 'create', `v${version}`, ...f.filenames.map(name => path.join(f.assets, name)), '--repo', repository,
      '--target', f.head, '--prerelease', '--latest=false', '--title', `Murmur ${version}`, '--notes-file', f.notes],
  ]);
});

test('invalid tags/options/run IDs fail before credentials or network', async t => {
  const f = await fixture(t);
  for (const args of [
    ['--tag', 'v999.0.0'], ['--tag', 'v0.6.0'], ['--tag', `v${version};echo unsafe`],
    ['--repo', 'other/repo'], ['--publish', '--publish'], ['--assets'], ['--check-run', '1234', '--publish'],
    ['--candidate-run', '1234;echo unsafe'], ['--check-run', '../1234'], ['--check-run', '0'],
    ['--readiness', f.readinessFile],
  ]) await f.refuse(/Invalid|Missing|matching|accepts only|positive decimal|require --publish/, args);
});

test('each gate and each evidence field must explicitly pass', async t => {
  const f = await fixture(t);
  for (const gate of gates) {
    for (const value of ['blocked', 'failed', true, undefined]) {
      f.readiness.gates[gate] = value;
      await f.saveReadiness();
      await f.refuse(new RegExp(`Release gate ${gate}`));
    }
    f.readiness.gates[gate] = 'passed';
    for (const value of ['', '   ', undefined]) {
      f.readiness.evidence[gate] = value;
      await f.saveReadiness();
      await f.refuse(new RegExp(`Release gate ${gate}`));
    }
    f.readiness.evidence[gate] = 'Fixture evidence';
  }
});

test('readiness binds schema, repository, HEAD, tag, version, run and affirmative approval', async t => {
  const f = await fixture(t);
  for (const [field, value] of Object.entries({ schemaVersion: 2, repository: 'fork/murmur', commit: '0'.repeat(40), tag: 'v1.0.0-alpha', version: '1.0.0-alpha', candidateRun: '9999', releaseReady: 'true', reviewedBy: '' })) {
    const previous = f.readiness[field];
    f.readiness[field] = value;
    await f.saveReadiness();
    await f.refuse(/Readiness|readiness|reviewer/);
    f.readiness[field] = previous;
  }
});

test('every asset byte hash and length is bound, including checksum and SBOM', async t => {
  const f = await fixture(t);
  for (const name of f.filenames) {
    for (const field of ['sha256', 'bytes']) {
      const previous = f.readiness.artifacts[name][field];
      f.readiness.artifacts[name][field] = field === 'sha256' ? '0'.repeat(64) : previous + 1;
      await f.saveReadiness();
      await f.refuse(/exact release assets/);
      f.readiness.artifacts[name][field] = previous;
    }
  }
  f.readiness.artifacts['unexpected.txt'] = { sha256: '0'.repeat(64), bytes: 1 };
  await f.saveReadiness();
  await f.refuse(/exact release assets/);
});

test('changed archive still fails after an attacker recomputes its checksum', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.stage, 'package/new-file.txt'), 'changed payload');
  await f.repack();
  await f.refuse(/exact release assets/);
});

test('tampered checksum/SBOM and archive identity are refused before gh', async t => {
  for (const kind of ['checksum', 'checksum-whitespace', 'sbom-whitespace', 'archive-version', 'archive-name']) {
    await t.test(kind, async t => {
      const f = await fixture(t);
      if (kind === 'checksum') await writeFile(f.checksum, '0'.repeat(64) + '  ' + f.filenames[0] + '\n');
      if (kind === 'checksum-whitespace') await appendFile(f.checksum, '\n');
      if (kind === 'sbom-whitespace') await appendFile(f.sbom, '\n');
      if (kind === 'archive-version') await f.repack({ version: '9.0.0-alpha' });
      if (kind === 'archive-name') await f.repack({ name: 'not-murmur' });
      await f.refuse(/checksum|exact release assets|identity\/version/);
    });
  }
});

test('SBOM validates npm purl/version, not npm filesystem component name', async t => {
  const f = await fixture(t); // name "murmur" is deliberately not "murmur-local".
  for (const change of [
    bom => { bom.bomFormat = 'SPDX'; }, bom => { delete bom.components; },
    bom => { bom.components = []; }, bom => { bom.components[0].purl = `pkg:npm/another@${version}`; },
    bom => { bom.components[0].purl = 'pkg:npm/murmur-local@0.5.0'; },
    bom => { bom.components[0].version = '0.5.0'; },
  ]) {
    const bom = structuredClone(f.bom);
    change(bom);
    await json(f.sbom, bom);
    await f.refuse(/exact package purl and version/);
  }
});

test('stable, invalid, or divergent checkout versions cannot be released', async t => {
  for (const versions of [['0.5.0', '0.5.0'], [version, '0.5.0'], ['0.6.0-01', '0.6.0-01'], ['0.6.0-alpha..1', '0.6.0-alpha..1']]) {
    const f = await fixture(t);
    await json(path.join(f.checkout, 'package.json'), { version: versions[0] });
    await json(path.join(f.checkout, 'packages/murmur/package.json'), { name: 'murmur-local', version: versions[1] });
    await f.refuse(/both package versions/);
  }
});

test('dirty trees and incorrect workflow commit/repository refuse even preflight', async t => {
  const f = await fixture(t);
  await f.refuse(/workflow commit/, f.preflightArgs, { GITHUB_SHA: '0'.repeat(40) });
  await f.refuse(/workflow repository/, f.preflightArgs, { GITHUB_REPOSITORY: 'fork/murmur' });
  await writeFile(path.join(f.checkout, 'untracked.txt'), 'not tested');
  await f.refuse(/clean exact tested checkout/);
  await f.refuse(/clean exact tested checkout/, f.preflightArgs);
  await rm(path.join(f.checkout, 'untracked.txt'));
  await appendFile(path.join(f.checkout, 'scripts/release.mjs'), '\n// changed after testing\n');
  await f.refuse(/clean exact tested checkout/);
});

test('missing inputs, malformed records, empty notes and linked assets fail locally', async t => {
  const f = await fixture(t);
  await f.refuse(/requires an explicit/, ['--publish', ...f.preflightArgs]);
  await f.refuse(/requires an explicit/, ['--publish', '--assets', f.assets, '--readiness', f.readinessFile, '--notes', f.notes]);
  await writeFile(f.readinessFile, '{');
  await f.refuse(/JSON/);
  await f.saveReadiness();
  await writeFile(f.notes, ' \n');
  await f.refuse(/notes must not be empty/);
  await writeFile(f.notes, 'notes');
  await rm(f.sbom);
  await symlink(f.readinessFile, f.sbom);
  await f.refuse(/regular files/);
});

test('source-run precheck permits only the exact trusted first-attempt successful run', async t => {
  const f = await fixture(t);
  assert.deepEqual(JSON.parse((await f.invoke(['--check-run', '1234'])).stdout), {
    repository, commit: f.head, candidateRun: '1234', artifactId: 5678,
  });
  assert.deepEqual(await f.calls(), [['api', f.sourceRoute], ['api', f.artifactRoute]]);
  const original = structuredClone(f.source);
  for (const change of [
    source => { source.id = 9999; }, source => { source.repository.full_name = 'fork/murmur'; },
    source => { source.head_repository.full_name = 'fork/murmur'; }, source => { source.head_sha = '0'.repeat(40); },
    source => { source.path = '.github/workflows/other.yml'; }, source => { source.event = 'pull_request'; },
    source => { source.conclusion = 'failure'; }, source => { source.status = 'in_progress'; }, source => { source.run_attempt = 2; },
  ]) {
    Object.assign(f.source, structuredClone(original));
    change(f.source);
    await f.saveResponses();
    await writeFile(f.log, '');
    await assert.rejects(f.invoke(f.publishArgs), error => /successful first-attempt/.test(error.stderr));
    assert.deepEqual(await f.calls(), [['api', f.sourceRoute]], 'Untrusted source must stop before listing or downloading assets or publishing');
  }
});

test('wrong, expired, ambiguous, or missing source artifacts are refused without publication', async t => {
  const f = await fixture(t);
  const original = structuredClone(f.artifact);
  for (const change of [
    artifact => { artifact.expired = true; }, artifact => { artifact.name = 'other'; }, artifact => { artifact.id = -1; },
    artifact => { artifact.workflow_run.head_sha = '0'.repeat(40); }, artifact => { artifact.workflow_run.id = 9999; },
    artifact => { artifact.workflow_run.head_repository_id = 9999; }, artifact => { artifact.size_in_bytes = 0; },
  ]) {
    Object.assign(f.artifact, structuredClone(original));
    change(f.artifact);
    await f.saveResponses();
    await writeFile(f.log, '');
    await assert.rejects(f.invoke(f.publishArgs), error => /candidate artifact|Candidate artifact/.test(error.stderr));
    assert.deepEqual(await f.calls(), [['api', f.sourceRoute], ['api', f.artifactRoute]]);
  }
  for (const artifacts of [[], [original, { ...original, id: 5679 }]]) {
    await json(f.responses, { [f.sourceRoute]: f.source, [f.artifactRoute]: { total_count: artifacts.length, artifacts } });
    await writeFile(f.log, '');
    await assert.rejects(f.invoke(f.publishArgs), error => /unambiguous candidate artifact/.test(error.stderr));
    assert.equal((await f.calls()).length, 2);
  }
});

test('failed remote metadata or tag queries never fall through to publication', async t => {
  const f = await fixture(t);
  const original = JSON.parse(await readFile(f.responses, 'utf8'));
  for (const [index, route] of [f.sourceRoute, f.artifactRoute, f.tagRoute].entries()) {
    const responses = structuredClone(original);
    delete responses[route];
    await json(f.responses, responses);
    await writeFile(f.log, '');
    await assert.rejects(f.invoke(f.publishArgs), error => /Unexpected gh call/.test(error.stderr));
    const calls = await f.calls();
    assert.equal(calls.length, index + 1);
    assert(calls.every(args => args[0] === 'api'));
  }
});

test('an existing remote tag cannot bypass exact HEAD targeting', async t => {
  const f = await fixture(t);
  const responses = JSON.parse(await readFile(f.responses, 'utf8'));
  responses[f.tagRoute] = [{ ref: `refs/tags/v${version}`, object: { type: 'commit', sha: '0'.repeat(40) } }];
  await json(f.responses, responses);
  await assert.rejects(f.invoke(f.publishArgs), error => /refusing tag reuse/.test(error.stderr));
  assert.deepEqual(await f.calls(), [['api', f.sourceRoute], ['api', f.artifactRoute], ['api', f.tagRoute]]);
});

test('exact candidate smoke test installs offline outside checkout with lifecycle scripts disabled', async t => {
  const f = await fixture(t);
  const result = await run(process.execPath, [path.join(f.checkout, 'scripts/verify-package.mjs'), f.archive],
    { cwd: f.checkout, env: f.env, timeout: 60000, maxBuffer: 1024 * 1024 });
  assert.deepEqual(JSON.parse(result.stdout), { archive: await realpath(f.archive), sha256: digest(await readFile(f.archive)), offlineInstall: true, cliHelp: true });
  assert.deepEqual(await f.calls(), []);
});

test('runtime SBOM generation stays offline and refuses overwriting an artifact', async t => {
  const f = await fixture(t);
  await copyFile(path.join(root, 'scripts/sbom.mjs'), path.join(f.checkout, 'scripts/sbom.mjs'));
  await json(path.join(f.checkout, 'package.json'), { name: 'murmur-workspace', version, private: true, workspaces: ['packages/murmur'] });
  const env = { ...f.env, NPM_CONFIG_USERCONFIG: path.join(f.temporaryRoot, 'user.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: path.join(f.temporaryRoot, 'global.npmrc') };
  await run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(f.temporaryRoot, 'cache')],
    { cwd: f.checkout, env, timeout: 60000 });
  const output = path.join(f.temporaryRoot, 'generated-sbom.json');
  const args = [path.join(f.checkout, 'scripts/sbom.mjs'), '--out', output];
  const options = { cwd: f.checkout, env, timeout: 60000, maxBuffer: 1024 * 1024 };
  await run(process.execPath, args, options);
  const bytes = await readFile(output);
  const bom = JSON.parse(bytes);
  assert.equal(bom.bomFormat, 'CycloneDX');
  assert(bom.components.some(component => component.purl === `pkg:npm/murmur-local@${version}` && component.version === version));
  await assert.rejects(run(process.execPath, args, options), error => /EEXIST/.test(error.stderr));
  assert.deepEqual(await readFile(output), bytes);
  assert.deepEqual(await f.calls(), []);
});

test('workflow is manual, disabled pending verified action pins, least-privileged and binds prior assets', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/prerelease.yml'), 'utf8');
  assert.match(workflow, /on:\n  workflow_dispatch:/);
  assert.match(workflow, /false && github.repository == 'boyeesu\/murmur'/);
  assert.match(workflow, /environment: release/);
  assert.equal((workflow.match(/contents: write/g) ?? []).length, 1);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /needs: \[activation, source\]/);
  assert.match(workflow, /--check-run "\$CANDIDATE_RUN"/);
  assert.match(workflow, /artifact-ids: \$\{\{ needs.source.outputs.artifact_id \}\}/);
  assert.match(workflow, /--readiness "\$RUNNER_TEMP\/release-readiness.json"/);
  assert.match(workflow, /READINESS_JSON: \$\{\{ inputs.readiness_json \}\}/);
  assert.match(workflow, /scripts\/verify-package.mjs "\$CANDIDATE_ARCHIVE"/);
  assert(!workflow.includes('--readiness docs/release-readiness.json'));
  assert(!/npm publish|pull_request_target|auto-merge|id-token: write/.test(workflow));
  assert.equal((workflow.match(/uses: actions\/checkout@/g) ?? []).length, (workflow.match(/persist-credentials: false/g) ?? []).length);
  // Check every literal or multiline shell body, not only the "run:" line.
  const lines = workflow.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)(?:- )?run: (.*)$/);
    if (!match) continue;
    let body = match[2];
    if (body === '|') {
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].match(/^\s*/)[0].length > match[1].length)) body += '\n' + lines[++i];
    }
    assert(!body.includes('${{'), 'Workflow contexts must reach shell only via env, never interpolation');
  }
});
