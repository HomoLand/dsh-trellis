// Verify the packed npm tarball contents, host ESM import, and DSH Web client factory.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const root = fileURLToPath(new URL("../", import.meta.url));
const ignoreScripts = process.argv.includes("--ignore-scripts");
const dir = mkdtempSync(join(tmpdir(), "dsh-trellis-pack-"));

try {
  const npmArgs = ["pack", ...(ignoreScripts ? ["--ignore-scripts"] : []), "--pack-destination", dir];
  execFileSync(
    process.platform === "win32" ? "cmd.exe" : "npm",
    process.platform === "win32" ? ["/d", "/s", "/c", "npm", ...npmArgs] : npmArgs,
    { cwd: root, stdio: "inherit", windowsHide: true },
  );
  const tarball = readdirSync(dir).find((name) => name.endsWith(".tgz"));
  assert.ok(tarball, "npm pack must produce a .tgz artifact");

  execFileSync("tar", ["-xzf", join(dir, tarball), "-C", dir], { windowsHide: true });
  const unpacked = join(dir, "package");
  assert.equal(existsSync(join(unpacked, "scripts")), false, "tarball must not ship scripts/");
  assert.equal(existsSync(join(unpacked, "src")), false, "tarball must not ship src/");

  symlinkSync(
    resolve(root, "node_modules"),
    join(dir, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const pkg = JSON.parse(readFileSync(join(unpacked, "package.json"), "utf8"));
  assert.equal(pkg.name, "dsh-trellis");
  assert.ok(readFileSync(join(unpacked, "cordis.patch.yml"), "utf8").length > 0);

  const hostMod = await import(pathToFileURL(join(unpacked, "lib/index.js")).href);
  assert.equal(typeof hostMod.apply, "function");

  let decl;
  vm.runInNewContext(readFileSync(join(unpacked, "lib/client.js"), "utf8"), {
    window: { __ModuleLoader__: { load(value) { decl = value; } } },
    document: {},
  });
  assert.equal(decl?.id, "dsh-trellis");
  assert.equal(typeof decl?.factory, "function");

  const map = JSON.parse(readFileSync(join(unpacked, "lib/client.js.map"), "utf8"));
  assert.equal(map.sourcesContent, undefined);
  console.log(`Verified tarball: ${tarball}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
