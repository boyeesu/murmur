import { HOOK_EVENTS, runContextHook } from '../hooks/context.js';
import type { ContextHookOptions, HookEvent } from '../hooks/context.js';
import { MurmurError } from '../protocol/index.js';

export type HookMainOptions = ContextHookOptions;

/** argv starts after `hook`; this entry point owns its single stdout object. */
export async function hookMain(argv: string[], options: HookMainOptions = {}): Promise<void> {
  const [tool, flag, event] = argv;
  if (argv.length !== 3 || (tool !== 'claude' && tool !== 'codex') || flag !== '--event' || !HOOK_EVENTS.includes(event as HookEvent)) {
    throw new MurmurError('Usage: murmur hook <claude|codex> --event <SessionStart|UserPromptSubmit|PreToolUse|PostToolUse>', 'HOOK_ARGUMENTS');
  }
  await runContextHook(tool, event as HookEvent, options);
}
