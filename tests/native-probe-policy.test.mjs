import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Codex probe does not bypass native permissions or preapprove project trust', async () => {
  const source = await readFile(new URL('../scripts/probe-codex-connector.mjs', import.meta.url), 'utf8');
  assert(!source.includes('--dangerously-bypass'));
  assert(!source.includes('trust_level = "trusted"'));
  assert(source.includes('fixtureHookTrustBypass: false'));
  assert(source.includes('fixtureProjectPretrusted: false'));
});
