<!-- Draft PR description for thedotmack/claude-mem. Not posted. Branch:
rich-murphey/claude-mem plugin-session-id; the PR carries only the
feat(hooks) commit, not the fork's version bump, rebuilt bundles or this file. -->

# feat(hooks): send contentSessionId on server semantic injection

## What

In the server runtime, the UserPromptSubmit hook's per-prompt injection
(`ServerClient.semanticContext` → `POST /v1/context/semantic`) now sends the
Claude Code session id as `contentSessionId`, the same field and value the
hook already sends on `POST /v1/sessions/start` and `POST /v1/events`
(`buildStartSessionPayload`, `buildEventPayload`).

- `src/services/hooks/server-client.ts`: optional `contentSessionId` on
  `ServerSemanticContextRequest`; added to the body only when set.
- `src/cli/handlers/session-init.ts`: `fetchServerSemanticContext` receives
  the hook's `sessionId` and passes it through.
- Tests: `tests/services/hooks/server-client-semantic.test.ts` checks the
  field is sent when given and absent otherwise;
  `tests/cli/handlers/session-init-server-beta-context.test.ts` checks the
  handler passes the hook's session id.

## Why

Without a session id the server cannot tell the asking session's own recent
observations from everyone else's, so injection keeps handing a session back
what it wrote a few minutes ago: noise that displaces older, relevant memory.
A server that knows the session can leave those rows out (a self-hosted
server does exactly this, keyed on `contentSessionId` against the sessions
`/v1/sessions/start` created). Every other server call from the hook already
names the session; this was the one that did not.

## Compatibility

- The field is optional. `ServerV1PostgresRoutes`' `/v1/context/semantic`
  schema is a non-strict `z.object`, so the bundled server strips the unknown
  key and answers as before; no server change is needed to merge this.
- The worker runtime path (`/api/context/semantic`) is untouched.

## Not in this PR

A compaction signal. A compaction keeps the session id, so a server that
excludes a session's own rows has no boundary to reset at; SessionStart
(`compact`) reads `/v1/context` without a session id, and PreCompact sends
nothing. Sending `{contentSessionId, source}` there would need a server-side
contract first, so it is left for a follow-up.

## Testing

`bun test tests/services/hooks/server-client-semantic.test.ts
tests/cli/handlers/session-init-server-beta-context.test.ts` and the fast
lane (`npm test`).
