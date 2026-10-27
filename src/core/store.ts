import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS } from '../contract.ts';
import type { CoreSnapshot } from '../contract.ts';
import { validateSnapshot } from './validation.ts';

export class RuntimeStore {
  private readonly root: string;
  private writes: Promise<void> = Promise.resolve();
  constructor(dataRoot: string) { this.root = dataRoot; }
  async load(): Promise<CoreSnapshot> {
    await this.writes;
    try {
      const value: unknown = JSON.parse(await readFile(join(this.root, 'runtime.json'), 'utf8'));
      return validateSnapshot(value);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { jobs: [], activeJobId: null, settings: { ...DEFAULT_SETTINGS }, memory: [] };
      throw new Error('Runtime data could not be read safely', { cause: error });
    }
  }
  save(snapshot: CoreSnapshot): Promise<void> {
    const text = JSON.stringify(snapshot);
    const write = this.writes.then(async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temporary = join(this.root, `.runtime-${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(text, 'utf8'); await file.sync(); } finally { await file.close(); }
        await rename(temporary, join(this.root, 'runtime.json'));
        const directory = await open(this.root, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await unlink(temporary).catch(() => undefined); }
    });
    this.writes = write.catch(() => undefined);
    return write;
  }
}
