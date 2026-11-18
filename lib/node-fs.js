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
import { dirname, join } from "node:path";

/** @type {import("./workflow.js").FsShim & { replaceFileIfUnchanged(path: string, expected: string, content: string, signal?: AbortSignal): Promise<boolean> }} */
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
      return { mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  },
  async readFile(path) {
    try {
      return await nodeReadFile(path, "utf8");
    } catch {
      return null;
    }
  },
  async replaceFileIfUnchanged(path, expected, content, signal) {
    signal?.throwIfAborted();
    // Replace the physical target so template symlinks keep pointing to it.
    const target = await realpath(path);
    const { mode } = await nodeStat(target);
    const temporary = join(dirname(target), `.trellis-doctor-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", mode & 0o777);
    try {
      try {
        await file.writeFile(content, "utf8");
        if (process.platform !== "win32") await file.chmod(mode & 0o777);
      } finally {
        await file.close();
      }
      // A directory entry can be replaceable even when the file is read-only.
      await access(target, constants.W_OK);
      if (await realpath(path) !== target || await nodeReadFile(target, "utf8") !== expected) {
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
