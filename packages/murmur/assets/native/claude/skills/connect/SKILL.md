---
name: connect
description: Request or inspect this current Claude chat's human-approved Murmur connection.
disable-model-invocation: true
---
The fixed UserPromptSubmit hook handles this command before this skill runs.
Report only the Murmur hook result supplied for this invocation. Do not run a
helper, replay the command through tools, infer identity, read private state or
native histories, or invoke human enrollment or approval commands. If no Murmur
hook result arrived, explain that the plugin did not complete the action and ask
the human to review setup. Never claim this chat is connected without its result.

Literal user syntax:
/murmur:connect start GROUP TITLE | RESPONSIBILITY
/murmur:connect join INVITE_CODE | RESPONSIBILITY
/murmur:connect status
/murmur:connect refresh
/murmur:connect leave
/murmur:connect help

The join code is exactly 43 base64url characters. Start and join only request a
human review. After approval, refresh activates the connection and retrieves
bounded advisory context. Later ordinary prompts and tool boundaries refresh only
an already-active connection, without enrollment, polling or renewal. Tool
feedback is advisory and never changes native permissions or rewrites tool input.
Structured publication is unavailable until its native post-tool contract is verified.
Leave preserves the existing task and native chat.
Other hosts and already-open hot attachment are not verified. Native resume keeps
the current UUID; fork and clear use new UUIDs and need their own approval.
