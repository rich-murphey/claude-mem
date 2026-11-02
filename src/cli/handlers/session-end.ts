// IO discipline (see src/shared/hook-io.ts): this handler is PURE. It returns a
// HookResult and MUST NOT call process.stderr.write / process.stdout.write /
// console.* / process.exit. logger.* calls are DIAGNOSTIC; thrown errors are
// caught by hookCommand, logged, and answered with a no-op (never exit 2).
import type { EventHandler, NormalizedHookInput, HookResult } from '../types.js';
import { spoolHookEvent } from '../spool-hook-event.js';
import { logger } from '../../utils/logger.js';
import { HOOK_EXIT_CODES } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { shouldTrackProject } from '../../shared/should-track-project.js';
import { resolveRuntimeContext } from '../../services/hooks/runtime-selector.js';

// Claude Code gives plugin SessionEnd hooks a 1.5-second budget, so this hook
// only spools the request and pokes the worker; it never waits on the worker.
// In server runtime it makes one request, named by the agent's own session id
// so no /v1/sessions/start is needed, bounded well inside that budget.
const SERVER_SESSION_END_TIMEOUT_MS = 1_000;

export const sessionEndHandler: EventHandler = {
  async execute(input: NormalizedHookInput): Promise<HookResult> {
    const { sessionId } = input;

    if (!sessionId) {
      logger.warn('HOOK', 'session-end: No sessionId provided, skipping');
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Session-init never registers an untracked session (observer, plugin cache,
    // excluded project), so its SessionEnd would sit in the spool until it expired.
    if (!shouldTrackProject(input.cwd ?? '')) {
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    const platformSource = normalizePlatformSource(input.platform);
    const runtime = resolveRuntimeContext();
    if (runtime.runtime === 'server') {
      // The session's real end: the server summarises what no compaction
      // covered and ends it. A turn's Stop no longer ends it (summarize.ts).
      try {
        await runtime.client.endSession(
          { sessionId, projectId: runtime.projectId, reason: input.reason || 'other' },
          { timeoutMs: SERVER_SESSION_END_TIMEOUT_MS },
        );
        logger.debug('HOOK', 'session-end: Session ended via server', { sessionId, reason: input.reason });
      } catch (error: unknown) {
        // The server's idle sweep ends a session whose SessionEnd never arrived.
        logger.warn('HOOK', 'session-end: Server end failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
    }

    // Keyed on (session, platform) only — the worker uses nothing else — so a
    // SessionEnd re-delivered with another reason still overwrites one entry.
    spoolHookEvent('session_end', { contentSessionId: sessionId, platformSource });

    logger.debug('HOOK', 'Session-end request spooled, exiting hook');
    return { continue: true, suppressOutput: true, exitCode: HOOK_EXIT_CODES.SUCCESS };
  },
};
