import { constants } from 'node:fs';
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out')) throw new Error('Usage: node scripts/pack.mjs [--out DIRECTORY]');
const output = path.resolve(args[1] ?? path.join(root, 'dist'));
const source = path.join(root, 'packages', 'murmur');
const execute = promisify(execFile);
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'murmur-package-')));
const stage = path.join(temporary, 'package');
const cache = path.join(temporary, 'cache');
const expectedFiles = new Set();
const noticeName = /^(?:licen[cs]e|copying|copyright|notice)(?:[.-].*)?$/i;
const archivePath = filename => path.relative(stage, filename).split(path.sep).join('/');
function within(parent, filename) {
  const relative = path.relative(parent, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function installedGraph(cwd, workspace) {
  try {
    const result = await execute('npm', ['ls', '--all', '--omit=dev', '--long', '--json', '--offline', '--ignore-scripts',
      '--cache', cache, ...(workspace ? [`--workspace=${workspace}`] : [])], { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 60000 });
    const graph = JSON.parse(result.stdout);
    const selected = workspace ? graph.dependencies?.[workspace] : graph;
    if (!selected?.path) throw new Error('npm did not report the requested package.');
    return selected;
  } catch (error) {
    throw new Error(`Cannot read npm's installed production graph in ${cwd}: ${error.stderr || error.message}`, { cause: error });
  }
}

// Keep npm's physical locations and resolved edges, including peers and nested
// versions. This is not a dependency/version resolver: npm supplies both graphs.
function graphNodes(graph) {
  const nodes = new Map();
  function visit(node) {
    if (typeof node.path !== 'string' || !path.isAbsolute(node.path)) throw new Error('npm reported an unsupported package location.');
    let record = nodes.get(node.path);
    if (!record) {
      record = { version: node.version, edges: new Map() };
      nodes.set(node.path, record);
    }
    for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
      // npm emits {} for an absent optional dependency/peer. Missing required
      // dependencies and invalid versions instead make npm ls fail above.
      const target = dependency.path ?? null;
      if (target === null && Object.keys(dependency).length) throw new Error(`npm did not report a location for ${name}.`);
      if (record.edges.has(name) && record.edges.get(name) !== target) throw new Error(`npm reported conflicting edges for ${name}.`);
      record.edges.set(name, target);
      if (target !== null) visit(dependency);
    }
  }
  visit(graph);
  return nodes;
}

async function copyInput(input, destination, runtime = false) {
  let notices = 0;
  await cp(input, destination, { recursive: true, dereference: false, force: false, errorOnExist: true, filter: async entry => {
    // Copy each reported dependency separately; never sweep in another package,
    // workspace link, .bin link, or a development-only node_modules tree.
    if (path.relative(input, entry).split(path.sep).includes('node_modules')) return false;
    const info = await lstat(entry);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error(`Unsupported linked or non-regular package input: ${entry}`);
    if (runtime && info.isFile() && path.dirname(entry) === input && noticeName.test(path.basename(entry))) {
      expectedFiles.add(archivePath(path.join(destination, path.basename(entry))));
      notices++;
    }
    return true;
  } });
  if (runtime) {
    if (!notices) throw new Error(`Installed runtime package has no license or notice file: ${input}`);
    expectedFiles.add(archivePath(path.join(destination, 'package.json')));
  }
}

try {
  if (await realpath(source) !== source) throw new Error('The package source must not be a directory link.');
  await mkdir(stage, { mode: 0o700 });
  for (const name of ['package.json', 'LICENSE', 'README.md', 'dist', 'docs']) {
    await copyInput(path.join(source, name), path.join(stage, name));
  }
  const manifest = JSON.parse(await readFile(path.join(stage, 'package.json'), 'utf8'));
  const workspace = await installedGraph(root, manifest.name);
  if (await realpath(workspace.path) !== source) throw new Error('npm resolved the workspace to an unexpected source directory.');
  const original = graphNodes(workspace);
  const placements = new Map([[workspace.path, stage]]);
  const occupied = new Map([[stage, workspace.path]]);
  for (const installed of original.keys()) {
    if (installed === workspace.path) continue;
    const parent = [path.join(source, 'node_modules'), path.join(root, 'node_modules')].find(directory => within(directory, installed));
    if (!parent || await realpath(installed) !== installed) throw new Error(`Unsupported external or linked runtime package: ${installed}`);
    const relative = path.relative(parent, installed);
    // Only npm's conventional physical node_modules layout is supported. In
    // particular, do not dereference stores, workspace links or other projects.
    if (!/^(?:@[^/]+\/)?[^/@.][^/]*(?:\/node_modules\/(?:@[^/]+\/)?[^/@.][^/]*)*$/.test(relative.split(path.sep).join('/'))) {
      throw new Error(`Unsupported runtime package layout: ${installed}`);
    }
    const destination = path.join(stage, 'node_modules', relative);
    if (occupied.has(destination) && occupied.get(destination) !== installed) {
      throw new Error(`Conflicting workspace/hoisted runtime locations: ${occupied.get(destination)} and ${installed}`);
    }
    placements.set(installed, destination);
    occupied.set(destination, installed);
  }
  // npm cannot compute the full bundled closure through a node_modules symlink.
  // Materialize just the installed prod graph, preserving all nested locations.
  for (const [installed, destination] of [...placements].sort((a, b) => a[1].length - b[1].length)) {
    if (destination === stage) continue;
    await mkdir(path.dirname(destination), { recursive: true });
    await copyInput(installed, destination, true);
  }
  const staged = graphNodes(await installedGraph(stage));
  if (staged.size !== original.size) throw new Error('Staging changed the installed production package set.');
  for (const [installed, node] of original) {
    const relocated = staged.get(placements.get(installed));
    if (!relocated || relocated.version !== node.version || relocated.edges.size !== node.edges.size ||
        [...node.edges].some(([name, target]) => relocated.edges.get(name) !== (target === null ? null : placements.get(target)))) {
      throw new Error(`Staging changed dependency or peer resolution for ${installed}. This installed layout is unsupported.`);
    }
  }
  const result = await execute('npm', ['pack', '--json', '--offline', '--ignore-scripts', '--cache', cache], { cwd: stage, maxBuffer: 32 * 1024 * 1024, timeout: 60000 });
  const info = JSON.parse(result.stdout)[0];
  const archived = new Set(info.files.map(file => file.path));
  for (const filename of expectedFiles) {
    if (!archived.has(filename)) throw new Error(`A runtime dependency or license was omitted from the archive: ${filename}`);
  }
  for (const dependency of manifest.bundledDependencies ?? []) {
    if (!info.bundled?.includes(dependency) || !archived.has(`node_modules/${dependency}/package.json`)) throw new Error('A declared runtime dependency was omitted from the archive.');
  }
  if (typeof info.filename !== 'string' || path.basename(info.filename) !== info.filename) throw new Error('Unexpected npm archive name.');
  await mkdir(output, { recursive: true });
  await copyFile(path.join(stage, info.filename), path.join(output, info.filename), constants.COPYFILE_EXCL);
  process.stdout.write(JSON.stringify([info], null, 2) + '\n');
} finally {
  // Staging contains only physical copies; no node_modules link is ever created.
  await rm(temporary, { recursive: true, force: true });
}
