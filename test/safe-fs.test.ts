import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccessDenied, SafeFs, isAllowedFile } from '../src/server/safe-fs.js';
import { makeClaudeDir, PROJECT, SID } from './helpers.js';

describe('allowlist', () => {
  it('allows only the files the app needs', () => {
    expect(isAllowedFile(`projects/${PROJECT}/${SID}.jsonl`)).toBe(true);
    expect(isAllowedFile(`projects/${PROJECT}/${SID}/subagents/agent-abc.jsonl`)).toBe(true);
    expect(isAllowedFile(`projects/${PROJECT}/${SID}/subagents/agent-abc.meta.json`)).toBe(true);
    expect(isAllowedFile(`projects/${PROJECT}/${SID}/tool-results/x.txt`)).toBe(true);
    expect(isAllowedFile('sessions/1234.json')).toBe(true);
    expect(isAllowedFile('history.jsonl')).toBe(true);
  });

  it('denies secrets and anything not listed', () => {
    for (const p of [
      'sessions/1234.abcdef.key',
      'sessions/1234.json.key',
      '.credentials.json',
      'remote-settings.json',
      'policy-limits.json',
      'daemon/state.json',
      'daemon-auth-status.json',
      'settings.json',
      `projects/${PROJECT}/memory/MEMORY.md`,
      `projects/${PROJECT}/../../sessions/1.key`,
      `/etc/passwd`,
      `projects/${PROJECT}/${SID}/tool-results/credentials.txt`,
    ]) {
      expect(isAllowedFile(p), p).toBe(false);
    }
  });
});

describe('SafeFs', () => {
  it('blocks symlinks that point at denied files', () => {
    const dir = makeClaudeDir();
    fs.writeFileSync(path.join(dir, 'sessions', '1.abc.key'), 'secret');
    fs.symlinkSync(path.join(dir, 'sessions', '1.abc.key'), path.join(dir, 'projects', PROJECT, `${SID}.jsonl`));
    const sfs = new SafeFs(dir);
    expect(() => sfs.readRange(`projects/${PROJECT}/${SID}.jsonl`, 0, 10)).toThrow(AccessDenied);
  });

  it('blocks symlinks that escape the Claude directory', () => {
    const dir = makeClaudeDir();
    const outside = path.join(path.dirname(dir), `outside-${path.basename(dir)}.jsonl`);
    fs.writeFileSync(outside, '{}\n');
    fs.symlinkSync(outside, path.join(dir, 'projects', PROJECT, `${SID}.jsonl`));
    const sfs = new SafeFs(dir);
    expect(() => sfs.stat(`projects/${PROJECT}/${SID}.jsonl`)).toThrow(AccessDenied);
  });

  it('reads byte ranges of allowed files', () => {
    const dir = makeClaudeDir();
    fs.writeFileSync(path.join(dir, 'projects', PROJECT, `${SID}.jsonl`), 'abcdef');
    const sfs = new SafeFs(dir);
    expect(sfs.readRange(`projects/${PROJECT}/${SID}.jsonl`, 2, 4).toString()).toBe('cd');
    expect(() => sfs.readText('settings.json')).toThrow(AccessDenied);
  });
});

describe('debug logs', () => {
  it('allows per-session debug logs but not the latest symlink', () => {
    expect(isAllowedFile('debug/11111111-2222-3333-4444-555555555555.txt')).toBe(true);
    expect(isAllowedFile('debug/latest')).toBe(false);
    expect(isAllowedFile('debug/../sessions/1.key')).toBe(false);
  });
});
