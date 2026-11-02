// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand, logged, and answered with a no-op (never exit 2).
//
// Claude Code PreCompact, server runtime: the compaction is about to replace
// the conversation, so ask the server to summarise the session's events since
// its last summary (POST /v1/sessions/:id/checkpoint). The session goes on. The
// hook is async and every failure is swallowed: it must never hold up or fail
// a compaction. Worker runtime has no checkpoint and does nothing here.
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { resolveRuntimeContext } from '../../services/hooks/runtime-selector.js';

const SERVER_CHECKPOINT_TIMEOUT_MS = 5_000;

export const preCompactHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const done: HookResult = { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    const { sessionId } = input;
    if (!sessionId || input.agentId) return done;
    if (input.cwd && !shouldTrackProject(input.cwd)) return done;

    const runtime = resolveRuntimeContext();
    if (runtime.runtime !== 'server') return done;

    try {
      const platformSource = normalizePlatformSource(input.platform);
      const options = { timeoutMs: SERVER_CHECKPOINT_TIMEOUT_MS };
      const started = await runtime.client.startSession({
        projectId: runtime.projectId,
        externalSessionId: sessionId,
        contentSessionId: sessionId,
        platformSource,
      }, options);
      await runtime.client.checkpointSession({
        sessionId: started.session.id,
        reason: 'compact',
        trigger: input.compactTrigger,
      }, options);
      logger.debug('HOOK', 'pre-compact: Checkpoint requested via server', { sessionId, trigger: input.compactTrigger });
    } catch (error: unknown) {
      logger.warn('HOOK', 'pre-compact: Server checkpoint failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return done;
  },
};
