/**
 * PAXELBOX-58: the production `AcquisitionStorage`, backed by the filesystem.
 *
 * The runner's ordering guarantee — raw artifact written BEFORE the checkpoint
 * that claims it — is only worth as much as the durability underneath it. A
 * checkpoint torn in half by a crash would, on the next run, either be
 * unreadable (safe) or readable-but-wrong (not safe). `writeCheckpoint` is
 * therefore write-temp → fsync → rename, which is atomic on POSIX and on NTFS:
 * a reader sees the old file or the new one, never a partial one.
 *
 * Nothing here is created on import. The directory is made on first write, so
 * merely importing this module leaves the filesystem untouched.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { isResumable, rawFileName, type AcquisitionStorage, type Checkpoint } from './rajaongkir-acquisition';

/** Gitignored (see .gitignore: backend/prisma/data/rajaongkir-cache/). */
export const DEFAULT_CACHE_ROOT = path.join('prisma', 'data', 'rajaongkir-cache');
export const CHECKPOINT_FILENAME = 'checkpoint.json';

export class CorruptCheckpointError extends Error {
  constructor(reason: string) {
    super(`checkpoint is unusable: ${reason}`);
    this.name = 'CorruptCheckpointError';
  }
}

/**
 * The checkpoint claims a unit is complete but its artifact is not on disk.
 * PAXELBOX-60F-B: this is a hard stop. The alternatives are all worse - an
 * empty pool would report the district as NOT_FOUND, dropping it from
 * completedUnits would silently re-spend quota, and re-requesting it
 * automatically would do so without anyone deciding to.
 */
export class MissingArtifactError extends Error {
  constructor(unitKey: string, file: string) {
    super(`artifact for completed unit "${unitKey}" is missing (expected ${file})`);
    this.name = 'MissingArtifactError';
  }
}

/** The artifact exists but cannot be trusted. Also a hard stop. */
export class CorruptArtifactError extends Error {
  constructor(unitKey: string, reason: string) {
    super(`artifact for unit "${unitKey}" is unusable: ${reason}`);
    this.name = 'CorruptArtifactError';
  }
}

export interface FileStorageOptions {
  /**
   * Fail closed on an unreadable or stale-version checkpoint (default).
   *
   * The alternative — treating it as "no checkpoint" — would silently
   * RE-ACQUIRE every unit, spending a whole unmeasured daily quota to recover
   * from a file we could have looked at. Refusing costs one operator decision.
   */
  failClosedOnCorrupt?: boolean;
}

/**
 * `unitKey` is never trusted as a path. `rawFileName` already collapses
 * anything outside [a-z0-9._-] and strips leading dots, but two different keys
 * can collapse to the same safe name, so a short digest of the ORIGINAL key is
 * appended: distinct units can never overwrite each other's artifact.
 */
export function artifactName(unitKey: string): string {
  const base = rawFileName(unitKey).replace(/\.json$/, '');
  const digest = createHash('sha256').update(unitKey).digest('hex').slice(0, 8);
  return `${base}.${digest}.json`;
}

export function createFileStorage(
  root: string = DEFAULT_CACHE_ROOT,
  options: FileStorageOptions = {},
): AcquisitionStorage {
  const failClosed = options.failClosedOnCorrupt ?? true;
  const checkpointPath = path.join(root, CHECKPOINT_FILENAME);

  async function writeAtomic(filePath: string, contents: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // Unique temp name so two runs cannot collide on it mid-rename.
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync(); // durable on disk before it is visible under the real name
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmp, filePath);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  return {
    async readCheckpoint(): Promise<unknown | null> {
      let text: string;
      try {
        text = await fs.readFile(checkpointPath, 'utf8');
      } catch (err) {
        // Genuinely absent — a fresh run. Any OTHER error (permissions, EISDIR)
        // is NOT silently treated as "nothing acquired yet".
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        if (failClosed) throw new CorruptCheckpointError('file is not valid JSON');
        return null;
      }

      // `isResumable` also rejects a stale CHECKPOINT_VERSION. Both cases mean
      // "we cannot trust completedUnits", and both must stop rather than
      // silently restart a run that would re-spend the quota.
      if (!isResumable(parsed)) {
        if (failClosed) {
          throw new CorruptCheckpointError('shape is invalid or CHECKPOINT_VERSION does not match');
        }
        return null;
      }
      return parsed;
    },

    async writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
      await writeAtomic(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    },

    async readRaw(unitKey: string): Promise<unknown> {
      // Same deterministic name writeRaw uses, so the caller never needs to
      // know where artifacts live or how they are named.
      const name = artifactName(unitKey);
      const file = path.join(root, name);
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new MissingArtifactError(unitKey, name);
        throw err;
      }
      try {
        // Returned VERBATIM - parsed, never normalised, and never written back.
        return JSON.parse(text);
      } catch {
        throw new CorruptArtifactError(unitKey, 'file is not valid JSON');
      }
    },

    async writeRaw(unitKey: string, body: unknown): Promise<string> {
      const name = artifactName(unitKey);
      // Same atomic path: a half-written artifact must never be claimed by a
      // checkpoint that the runner writes immediately afterwards.
      await writeAtomic(path.join(root, name), `${JSON.stringify(body, null, 2)}\n`);
      return name;
    },
  };
}
