import test from 'node:test';
import assert from 'node:assert/strict';
import { appendInstallationJsoncArrayItem, removeInstallationJsoncArrayItem, parseInstallationJsonc } from '../packages/murmur/dist/integrations/jsonc.js';
const keys = ['hooks', 'UserPromptSubmit'];
const plain = value => JSON.parse(JSON.stringify(value));
const owned = { hooks: [{ type: 'command', command: '/fixed/murmur native hook', timeout: 30 }] };

test('format-aware native hook insertion preserves comments and unrelated permission hooks verbatim', () => {
  const original = '{\r\n  // native choices stay unchanged\r\n  "permissions": { "deny": ["Bash(rm *)"] },\r\n  "hooks": {\r\n    "PreToolUse": [ /* permission hooks */ { "hooks": [{"command":"permission-check"}] } ],\r\n    "UserPromptSubmit": [ { "hooks": [{"command":"existing"}] } /* retain this comment */, ],\r\n  },\r\n}\r\n';
  const result = appendInstallationJsoncArrayItem(original, keys, owned);
  assert(result.includes('// native choices stay unchanged')); assert(result.includes('"PreToolUse": [ /* permission hooks */ { "hooks": [{"command":"permission-check"}] } ]')); assert(result.includes('/* retain this comment */')); assert(result.includes('\r\n'));
  assert.deepEqual(plain(parseInstallationJsonc(result).hooks.UserPromptSubmit), [{ hooks: [{ command: 'existing' }] }, owned]);
  const removed = removeInstallationJsoncArrayItem(result, keys, owned);
  assert.deepEqual(parseInstallationJsonc(removed), parseInstallationJsonc(original)); assert(removed.includes('// native choices stay unchanged')); assert(removed.includes('/* retain this comment */'));
});

test('array patch supports absent objects and arrays without reserializing existing JSON', () => {
  for (const source of ['{}', '{ // trailing comment\n}', '{"hooks": {}}', '{"hooks":{"UserPromptSubmit":[]}}', '{"hooks":{"UserPromptSubmit":[{"old":true}]}}', '{"hooks":{"UserPromptSubmit":[{"old":true},]}}']) {
    const result = appendInstallationJsoncArrayItem(source, keys, owned); assert.deepEqual(plain(parseInstallationJsonc(result).hooks.UserPromptSubmit.at(-1)), owned);
    const removed = removeInstallationJsoncArrayItem(result, keys, owned); assert(!parseInstallationJsonc(removed).hooks.UserPromptSubmit.some(value => JSON.stringify(value) === JSON.stringify(owned)));
  }
});

test('duplicate keys, ambiguous item ownership, malformed JSONC and TOML are rejected instead of regex stripping', () => {
  for (const source of ['{"hooks":{},"hooks":{}}', '{"hooks":{"UserPromptSubmit":{}}}', '{"hooks":false}', '{"__proto__":{}}', '{ /* unterminated', '{"bad":"\\q"}', 'hooks = []', '{"a": 01}', '{"a": true false}', '{"a": [1,,]}']) assert.throws(() => appendInstallationJsoncArrayItem(source, keys, owned), { code: 'INSTALLATION_CONFIG_FORMAT' });
  const existing = JSON.stringify({ hooks: { UserPromptSubmit: [owned] } }); assert.throws(() => appendInstallationJsoncArrayItem(existing, keys, owned), { code: 'INSTALLATION_COLLISION' });
  assert.throws(() => removeInstallationJsoncArrayItem('{"hooks":{"UserPromptSubmit":[{"edited":true}]}}', keys, owned), { code: 'INSTALLATION_COLLISION' });
  assert.throws(() => removeInstallationJsoncArrayItem(JSON.stringify({ hooks: { UserPromptSubmit: [owned, owned] } }), keys, owned), { code: 'INSTALLATION_COLLISION' });
});

test('JSONC edits retain one leading UTF-8 BOM without accepting embedded BOM trivia', () => {
  const source = '﻿{\r\n // preserve my BOM and comment\r\n "hooks": {"UserPromptSubmit": []}\r\n}\r\n';
  const inserted = appendInstallationJsoncArrayItem(source, keys, owned);
  assert(inserted.startsWith('﻿')); assert(inserted.includes('// preserve my BOM and comment'));
  const removed = removeInstallationJsoncArrayItem(inserted, keys, owned);
  assert(removed.startsWith('﻿')); assert.deepEqual(parseInstallationJsonc(removed), parseInstallationJsonc(source));
  assert.throws(() => parseInstallationJsonc('{﻿"hooks": {}}'), { code: 'INSTALLATION_CONFIG_FORMAT' });
});
