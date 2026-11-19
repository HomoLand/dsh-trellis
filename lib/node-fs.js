/**
 * Node filesystem operations for Trellis workflow and template repair.
 *
 * @module dsh-trellis/node-fs
 */
import { constants } from "node:fs";
import {
  access,
  stat as nodeStat,
  readFile as nodeReadFile,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

function isWithinDirectory(candidate, baseDir) {
  const rel = relative(baseDir, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function assertWithinRoot(path, target, root) {
  const realRoot = await realpath(root);
  if (isWithinDirectory(target, realRoot)) return;
  const lexicalTrellis = resolve(root, ".trellis");
  if (isWithinDirectory(resolve(path), lexicalTrellis)) {
    try {
      const realTrellis = await realpath(lexicalTrellis);
      if (isWithinDirectory(target, realTrellis)) return;
    } catch {
      // Missing or broken .trellis falls through to refusal.
    }
  }
  throw Object.assign(
    new Error(`Refusing to modify symlink target outside project root: ${target}`),
    { code: "EACCES" },
  );
}

/** @type {{ exists(path: string): Promise<boolean>, stat(path: string): Promise<{mtimeMs: number, size: number, isDirectory: boolean, isFile: boolean} | null>, readFile(path: string): Promise<string | null>, realpath(path: string): Promise<string>, replaceFileIfUnchanged(path: string, expected: string, content: string, signal?: AbortSignal, options?: { root?: string }): Promise<boolean> }} */
export const nodeFs = {
  async exists(path) {
    try {
      await nodeStat(path);
      return true;
    } catch {
      return false;
    }
  },
  async stat(path) {
    try {
      const info = await nodeStat(path);
      return {
        mtimeMs: info.mtimeMs,
        size: info.size,
        isDirectory: info.isDirectory(),
        isFile: info.isFile(),
      };
    } catch {
      return null;
    }
  },
  async readFile(path) {
    try {
      return await nodeReadFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  },
  async realpath(path) {
    return realpath(path);
  },
  async replaceFileIfUnchanged(path, expected, content, signal, options = {}) {
    const root = options?.root;

    signal?.throwIfAborted();
    // Replace the physical target so template symlinks keep pointing to it.
    const target = await realpath(path);
    if (root !== undefined) {
      await assertWithinRoot(path, target, root);
    }
    const info = await nodeStat(target);
    if (!info.isFile()) {
      throw Object.assign(
        new Error(`Target path is not a regular file: ${target}`),
        { code: "EISDIR" },
      );
    }
    const mode = info.mode;
    // A directory entry can be replaceable even when the file is read-only.
    await access(target, constants.W_OK);
    const temporary = join(dirname(target), `.trellis-doctor-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", (mode & 0o777) | 0o200);
    try {
      try {
        await file.writeFile(content, "utf8");
        if (process.platform !== "win32") await file.chmod(mode & 0o777);
      } finally {
        await file.close();
      }
      await access(target, constants.W_OK);
      if (
        (await realpath(path)) !== target ||
        (await nodeReadFile(target, "utf8")) !== expected
      ) {
        return false;
      }
      signal?.throwIfAborted();
      await rename(temporary, target);
      return true;
    } finally {
      await rm(temporary, { force: true });
    }
  },
};
