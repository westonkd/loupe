// The only module allowed to touch files under the Claude directory (R3).
// Every path is checked against an allowlist of the files the app needs,
// with a denylist backstop and a realpath check so symlinks can't escape.
import fs from 'node:fs';
import path from 'node:path';

const ALLOWED_FILES: RegExp[] = [
  /^projects\/[^/]+\/[^/]+\.jsonl$/,
  /^projects\/[^/]+\/[^/]+\/subagents\/agent-[^/]+\.jsonl$/,
  /^projects\/[^/]+\/[^/]+\/subagents\/agent-[^/]+\.meta\.json$/,
  /^projects\/[^/]+\/[^/]+\/tool-results\/[^/]+$/,
  /^sessions\/\d+\.json$/,
  /^history\.jsonl$/,
  // Only written with --debug. Named by session id; `debug/latest` (a symlink) is not listed.
  /^debug\/[0-9a-zA-Z][0-9a-zA-Z_-]*\.txt$/,
];

const ALLOWED_DIRS: RegExp[] = [
  /^projects$/,
  /^projects\/[^/]+$/,
  /^projects\/[^/]+\/[^/]+$/,
  /^projects\/[^/]+\/[^/]+\/subagents$/,
  /^projects\/[^/]+\/[^/]+\/tool-results$/,
  /^sessions$/,
  /^debug$/,
];

// Backstop: even if an allowlist pattern is loosened later, these never open.
const DENY_BASENAME = /(\.key$|credential|^remote-settings|^policy-limits|^daemon)/i;
const DENY_TOP = /^(daemon|daemon-auth-)/i;

export class AccessDenied extends Error {
  constructor(public readonly relPath: string, reason: string) {
    super(`access denied: ${relPath} (${reason})`);
  }
}

let deniedCount = 0;
export function deniedOpenCount(): number {
  return deniedCount;
}

function normalizeRel(rel: string): string {
  const r = rel.replace(/\\/g, '/');
  if (r.startsWith('/') || r.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new AccessDenied(rel, 'bad path');
  }
  return r;
}

function isDenied(rel: string): boolean {
  const parts = rel.split('/');
  return DENY_TOP.test(parts[0]) || DENY_BASENAME.test(parts[parts.length - 1]);
}

export function isAllowedFile(rel: string): boolean {
  try {
    const r = normalizeRel(rel);
    return !isDenied(r) && ALLOWED_FILES.some((re) => re.test(r));
  } catch {
    return false;
  }
}

export function isAllowedDir(rel: string): boolean {
  try {
    const r = normalizeRel(rel);
    return !isDenied(r) && ALLOWED_DIRS.some((re) => re.test(r));
  } catch {
    return false;
  }
}

export class SafeFs {
  private readonly root: string;
  private realRoot: string | null = null;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private getRealRoot(): string {
    if (!this.realRoot) this.realRoot = fs.realpathSync(this.root);
    return this.realRoot;
  }

  private deny(rel: string, reason: string): never {
    deniedCount++;
    console.warn(`[safe-fs] denied ${reason}: ${rel}`);
    throw new AccessDenied(rel, reason);
  }

  /** Resolve an allowed relative path to an absolute one, following symlinks. */
  private resolve(rel: string, kind: 'file' | 'dir'): string {
    let r: string;
    try {
      r = normalizeRel(rel);
    } catch {
      this.deny(rel, 'bad path');
    }
    const ok = kind === 'file' ? isAllowedFile(r) : isAllowedDir(r);
    if (!ok) this.deny(r, 'not allowlisted');
    const abs = path.join(this.root, r);
    const real = fs.realpathSync(abs);
    const realRoot = this.getRealRoot();
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) this.deny(r, 'symlink escape');
    const realRel = path.relative(realRoot, real).split(path.sep).join('/');
    const okReal = kind === 'file' ? isAllowedFile(realRel) : isAllowedDir(realRel);
    if (!okReal) this.deny(r, `symlink target not allowlisted (${realRel})`);
    return real;
  }

  exists(rel: string): boolean {
    try {
      fs.accessSync(path.join(this.root, normalizeRel(rel)));
      return true;
    } catch {
      return false;
    }
  }

  stat(rel: string): fs.Stats | null {
    try {
      return fs.statSync(this.resolve(rel, 'file'));
    } catch (e) {
      if (e instanceof AccessDenied) throw e;
      return null;
    }
  }

  /** List entries of an allowlisted directory. Returns [] if missing. */
  readdir(rel: string): fs.Dirent[] {
    try {
      return fs.readdirSync(this.resolve(rel, 'dir'), { withFileTypes: true });
    } catch (e) {
      if (e instanceof AccessDenied) throw e;
      return [];
    }
  }

  readText(rel: string, maxBytes = 50 * 1024 * 1024): string {
    const abs = this.resolve(rel, 'file');
    const fd = fs.openSync(abs, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, maxBytes));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Read bytes [start, end) of an allowlisted file. */
  readRange(rel: string, start: number, end: number): Buffer {
    const abs = this.resolve(rel, 'file');
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.max(0, end - start));
      let off = 0;
      while (off < buf.length) {
        const n = fs.readSync(fd, buf, off, buf.length - off, start + off);
        if (n === 0) break;
        off += n;
      }
      return off === buf.length ? buf : buf.subarray(0, off);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Absolute path of an allowlisted file, for copying into the archive. */
  absolute(rel: string): string {
    return this.resolve(rel, 'file');
  }
}
