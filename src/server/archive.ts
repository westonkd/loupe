// Optional raw-transcript archive (ARCHIVE=1). Mirrors appended bytes into the
// data volume so history survives Claude Code's periodic cleanup. This is the
// only place the app writes transcript content, and it never writes under the
// Claude directory.
import fs from 'node:fs';
import path from 'node:path';

export class Archive {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  append(relPath: string, offset: number, bytes: Buffer, reset: boolean) {
    const dest = path.join(this.dir, relPath);
    if (!dest.startsWith(this.dir + path.sep)) return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (reset) {
      // The source was replaced or truncated: keep the old copy beside the new one.
      if (fs.existsSync(dest)) fs.renameSync(dest, `${dest}.${Date.now()}.old`);
    }
    let size = 0;
    try {
      size = fs.statSync(dest).size;
    } catch {
      size = 0;
    }
    // Only append bytes we don't already have (restarts re-read from the index offset).
    if (offset + bytes.length <= size) return;
    const skip = Math.max(0, size - offset);
    fs.appendFileSync(dest, bytes.subarray(skip));
  }
}
