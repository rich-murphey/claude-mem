// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { parseAnthropicExtraHeaders } from '../../../src/server/runtime/create-server-service.js';

describe('parseAnthropicExtraHeaders', () => {
  it('is undefined when unset or blank', () => {
    expect(parseAnthropicExtraHeaders(undefined)).toBeUndefined();
    expect(parseAnthropicExtraHeaders('  ')).toBeUndefined();
  });

  it('accepts a JSON object of string values', () => {
    expect(parseAnthropicExtraHeaders('{"cf-aig-collect-log-payload":"false"}'))
      .toEqual({ 'cf-aig-collect-log-payload': 'false' });
  });

  it('ignores malformed JSON, arrays and non-string values', () => {
    for (const raw of ['{', '["a"]', '{"a":1}', '"a"', 'null']) {
      expect(parseAnthropicExtraHeaders(raw)).toBeUndefined();
    }
  });
});
