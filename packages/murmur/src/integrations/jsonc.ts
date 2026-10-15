import { assert, canonicalJson, MurmurError } from '../protocol/index.js';

/** Minimal bounded JSON-with-comments parser retaining token spans. It does not
 * strip comments, round-trip the whole document, tolerate duplicate keys, or
 * guess TOML syntax. Edits touch only a selected additive array item.
 */
type Node = { start: number; end: number; value: unknown; kind: 'object' | 'array' | 'scalar'; entries: Node[]; properties: Map<string, Node>; comma: number | null };
function failure(): never { throw new MurmurError('Native JSON configuration is invalid, ambiguous, or unsupported; preserve it for manual review.', 'INSTALLATION_CONFIG_FORMAT'); }
class Parser {
  position = 0;
  readonly source: string;
  constructor(source: string) { this.source = source; this.position = source.startsWith("\uFEFF") ? 1 : 0; assert(Buffer.byteLength(source) <= 1024 * 1024, 'Native configuration exceeds 1 MiB.', 'INSTALLATION_CONFIG_FORMAT'); }
  trivia(): void {
    while (this.position < this.source.length) {
      const char = this.source[this.position];
      if (char === ' ' || char === '\t' || char === '\r' || char === '\n') { this.position++; continue; }
      if (this.source.startsWith('//', this.position)) { this.position += 2; while (this.position < this.source.length && this.source[this.position] !== '\n' && this.source[this.position] !== '\r') this.position++; continue; }
      if (this.source.startsWith('/*', this.position)) { const end = this.source.indexOf('*/', this.position + 2); if (end < 0) failure(); this.position = end + 2; continue; }
      break;
    }
  }
  string(): string {
    if (this.source[this.position++] !== '"') failure(); const start = this.position - 1;
    while (this.position < this.source.length) {
      const char = this.source[this.position++];
      if (char === '\\') { this.position++; continue; }
      if (char === '"') { try { return JSON.parse(this.source.slice(start, this.position)); } catch { return failure(); } }
      if (char!.charCodeAt(0) < 32) failure();
    }
    return failure();
  }
  node(depth = 0): Node {
    if (depth > 32) failure(); this.trivia();
    const start = this.position, char = this.source[this.position];
    const result: Node = { start, end: start, kind: 'scalar', value: null, entries: [], properties: new Map(), comma: null };
    if (char === '{' || char === '[') {
      const object = char === '{', close = object ? '}' : ']'; result.kind = object ? 'object' : 'array'; this.position++;
      const values: unknown[] = [], properties: Record<string, unknown> = Object.create(null);
      while (true) {
        this.trivia(); if (this.source[this.position] === close) { this.position++; break; }
        let key: string | undefined;
        if (object) { key = this.string(); if (result.properties.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) failure(); this.trivia(); if (this.source[this.position++] !== ':') failure(); }
        const entry = this.node(depth + 1); result.entries.push(entry);
        if (key !== undefined) { result.properties.set(key, entry); properties[key] = entry.value; } else values.push(entry.value);
        this.trivia(); if (this.source[this.position] === ',') { entry.comma = this.position++; continue; }
        if (this.source[this.position] !== close) failure(); this.position++; break;
      }
      result.value = object ? properties : values;
    } else if (char === '"') result.value = this.string();
    else {
      const rest = this.source.slice(this.position), match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest);
      if (!match) failure(); this.position += match[0].length;
      try { result.value = JSON.parse(match[0]); } catch { failure(); }
    }
    result.end = this.position; return result;
  }
  parse(): Node { const node = this.node(); this.trivia(); if (this.position !== this.source.length || node.kind !== 'object') failure(); return node; }
}
export function parseInstallationJsonc(source: string): unknown { return new Parser(source).parse().value; }
type Edit = { start: number; end: number; text: string };
function apply(source: string, edits: Edit[]): string {
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  new Parser(source).parse(); return source;
}
function append(source: string, container: Node, rendered: string): string {
  const previous = container.entries.at(-1), newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lastLine = source.lastIndexOf('\n', container.start - 1), prefix = source.slice(lastLine + 1, container.start), indentation = /^[ \t]*/.exec(prefix)![0];
  const edits: Edit[] = [{ start: container.end - 1, end: container.end - 1, text: `${newline}${indentation}  ${rendered}${newline}${indentation}` }];
  if (previous && previous.comma === null) edits.push({ start: previous.end, end: previous.end, text: ',' });
  return apply(source, edits);
}
export function appendInstallationJsoncArrayItem(source: string, keys: string[], item: unknown): string {
  assert(keys.length > 0 && keys.length <= 8 && keys.every(key => /^[A-Za-z0-9_.-]+$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key)), 'Invalid native configuration key path.', 'INSTALLATION_CONFIG_FORMAT');
  let node = new Parser(source).parse();
  for (let index = 0; index < keys.length; index++) {
    if (node.kind !== 'object') failure(); const key = keys[index]!, child = node.properties.get(key);
    if (!child) {
      let nested: unknown = [item]; for (let cursor = keys.length - 1; cursor > index; cursor--) nested = { [keys[cursor]!]: nested };
      return append(source, node, `${JSON.stringify(key)}: ${JSON.stringify(nested)}`);
    }
    if (index === keys.length - 1) {
      if (child.kind !== 'array') failure(); assert(!child.entries.some(entry => canonicalJson(entry.value) === canonicalJson(item)), 'Native hook registration already exists without installation ownership.', 'INSTALLATION_COLLISION'); return append(source, child, JSON.stringify(item));
    }
    node = child;
  }
  return failure();
}
export function removeInstallationJsoncArrayItem(source: string, keys: string[], item: unknown): string {
  let node = new Parser(source).parse();
  for (const key of keys) { const child = node.properties.get(key); if (node.kind !== 'object' || !child) failure(); node = child; }
  if (node.kind !== 'array') failure();
  const indices = node.entries.flatMap((entry, index) => canonicalJson(entry.value) === canonicalJson(item) ? [index] : []);
  assert(indices.length === 1, 'Murmur-owned native hook was edited, removed or duplicated; preserve it for human review.', 'INSTALLATION_COLLISION');
  const index = indices[0]!, entry = node.entries[index]!, edits: Edit[] = [{ start: entry.start, end: entry.end, text: '' }];
  if (entry.comma !== null) edits.push({ start: entry.comma, end: entry.comma + 1, text: '' });
  else if (index > 0) { const prior = node.entries[index - 1]!; if (prior.comma !== null) edits.push({ start: prior.comma, end: prior.comma + 1, text: '' }); }
  return apply(source, edits);
}
