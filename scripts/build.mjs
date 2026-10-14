import { readdir, mkdir, readFile, writeFile, chmod, cp, lstat, unlink } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const source = fileURLToPath(new URL('../packages/murmur/src/', import.meta.url));
const output = fileURLToPath(new URL('../packages/murmur/dist/', import.meta.url));
async function build(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await build(absolute);
    else if (entry.name.endsWith('.ts')) {
      const destination = path.join(output, path.relative(source, absolute).replace(/\.ts$/, '.js'));
      await mkdir(path.dirname(destination), { recursive: true });
      const javascript = stripTypeScriptTypes(await readFile(absolute, 'utf8'), { mode: 'strip' });
      await writeFile(destination, javascript);
      if (destination.endsWith(`${path.sep}cli${path.sep}index.js`)) await chmod(destination, 0o755);
    }
  }
}
await build(source);
console.log('Built Murmur (type stripping only; static type checking is a separate check).');

const dashboard = fileURLToPath(new URL('../apps/dashboard/', import.meta.url));
for (const file of ['index.html', 'app.js', 'styles.css']) {
  try { await mkdir(path.join(output, 'dashboard'), { recursive: true }); await cp(path.join(dashboard, file), path.join(output, 'dashboard', file)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

for (const file of ['LICENSE', 'README.md']) {
  await cp(fileURLToPath(new URL(`../${file}`, import.meta.url)), path.join(output, '..', file));
}

const documentation = ['user-guide.md', 'release-checklist.md', 'coordination.md', 'workflow.md', 'protocol.md', 'support-matrix.md', 'verification.md', 'agent-bridge.md', 'managed-launch.md', 'launch-service.md', 'mcp.md', 'context-hooks.md', 'native-integrations.md', 'opencode.md', 'session-linking.md', 'verification-existing-chats.md'];
const packagedDocs = path.join(output, '..', 'docs');
await mkdir(packagedDocs, { recursive: true });
for (const file of documentation) {
  await cp(fileURLToPath(new URL(`../docs/${file}`, import.meta.url)), path.join(packagedDocs, file));
}

// Remove only recognized legacy generated placeholders during a 0.4 upgrade.
for (const [file, marker] of [['claude/SKILL.md', 'NATIVE_ADAPTER_UNVERIFIED'], ['claude/hooks.json', '"hooks": {}']]) {
  const old = path.join(output, 'native', file);
  try {
    const info = await lstat(old);
    if (!info.isFile() || info.isSymbolicLink() || !(await readFile(old, 'utf8')).includes(marker)) throw new Error('Unrecognized legacy native build asset; preserve it for inspection.');
    await unlink(old);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

// Only explicit bundled native templates, never user/native configuration.
for (const file of ['claude/.claude-plugin/plugin.json', 'claude/skills/connect/SKILL.md', 'claude/hooks/hooks.json']) {
  const destination = path.join(output, 'native', file);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(fileURLToPath(new URL('../packages/murmur/assets/native/' + file, import.meta.url)), destination);
}
