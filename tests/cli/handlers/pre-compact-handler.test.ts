import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import * as realRuntimeSelector from '../../../src/services/hooks/runtime-selector.js';

const realRuntimeSelectorSnapshot = { ...realRuntimeSelector };

const calls: Array<{ method: string; input: unknown; options: unknown }> = [];
let useServerRuntime = true;
let checkpointFails = false;

mock.module('../../../src/services/hooks/runtime-selector.js', () => ({
  ...realRuntimeSelectorSnapshot,
  resolveRuntimeContext: () => useServerRuntime
    ? {
        runtime: 'server',
        projectId: 'server-project',
        serverBaseUrl: 'http://server.test',
        client: {
          startSession: async (input: unknown, options: unknown) => {
            calls.push({ method: 'startSession', input, options });
            return { session: { id: 'server-session' } };
          },
          checkpointSession: async (input: unknown, options: unknown) => {
            calls.push({ method: 'checkpointSession', input, options });
            if (checkpointFails) throw new Error('ECONNREFUSED');
            return {};
          },
        },
      }
    : { runtime: 'worker' },
}));

import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';
import { logger } from '../../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  calls.length = 0;
  useServerRuntime = true;
  checkpointFails = false;
  loggerSpies = [
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
});

afterAll(() => {
  mock.module('../../../src/services/hooks/runtime-selector.js', () => realRuntimeSelectorSnapshot);
});

describe('preCompactHandler', () => {
  it('starts the session, then asks the server for a checkpoint with the trigger', async () => {
    const { preCompactHandler } = await import('../../../src/cli/handlers/pre-compact.js');
    const input = claudeCodeAdapter.normalizeInput({
      session_id: 'cc-compact',
      cwd: '/tmp/compact-project',
      hook_event_name: 'PreCompact',
      trigger: 'manual',
      custom_instructions: '',
    });
    input.platform = 'claude-code';

    const result = await preCompactHandler.execute(input);

    expect(result.continue).toBe(true);
    expect(calls.map(c => c.method)).toEqual(['startSession', 'checkpointSession']);
    expect(calls[0].input).toMatchObject({ projectId: 'server-project', externalSessionId: 'cc-compact', contentSessionId: 'cc-compact' });
    expect(calls[1].input).toEqual({ sessionId: 'server-session', reason: 'compact', trigger: 'manual' });
  });

  it('never fails the compaction when the server does', async () => {
    const { preCompactHandler } = await import('../../../src/cli/handlers/pre-compact.js');
    checkpointFails = true;

    const result = await preCompactHandler.execute({ sessionId: 'cc-x', cwd: '/tmp/p', platform: 'claude-code', compactTrigger: 'auto' });

    expect(result.continue).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('does nothing for a subagent or in worker runtime', async () => {
    const { preCompactHandler } = await import('../../../src/cli/handlers/pre-compact.js');
    await preCompactHandler.execute({ sessionId: 'cc-sub', cwd: '/tmp/p', platform: 'claude-code', agentId: 'a1' });
    useServerRuntime = false;
    await preCompactHandler.execute({ sessionId: 'cc-w', cwd: '/tmp/p', platform: 'claude-code' });
    expect(calls).toHaveLength(0);
  });
});
