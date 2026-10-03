import { describe, expect, it } from 'vitest';
import { parseDebugLog } from '../src/server/console.js';

describe('parseDebugLog', () => {
  it('parses level, optional category with spaces, and continuation lines', () => {
    const log = [
      '2026-01-01T00:00:00.000Z [DEBUG] [STARTUP] booting',
      '2026-01-01T00:00:01.000Z [ERROR] [3P telemetry] failed to send',
      '  at line two',
      '2026-01-01T00:00:02.000Z [WARN] no category here',
      '',
    ].join('\n');
    const e = parseDebugLog(log);
    expect(e).toHaveLength(3);
    expect(e[0]).toMatchObject({ level: 'debug', category: 'STARTUP', text: 'booting' });
    expect(e[1]).toMatchObject({ level: 'error', category: '3P telemetry', text: 'failed to send\n  at line two' });
    expect(e[2]).toMatchObject({ level: 'warn', category: null, text: 'no category here' });
  });
});
