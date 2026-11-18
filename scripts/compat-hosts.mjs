// Exact published pins: Cordis, Schemastery, Include, Loader. Do not classify a
// new host by != latest, a version prefix, or the ordering of prerelease labels.
const workingDirectory = ["fs", "fs-local", "working-directory"];
const splitExecutors = [...workingDirectory, "tool-executor-native", "tool-executor-ptc"];
const HOSTS = new Map([
  ["0.1.5-rc.2", { pins: ["4.0.2", "3.18.2", "1.0.7", "1.0.3"], legacyCodeRuntime: true }],
  ["0.1.6-alpha.2", { pins: ["4.0.2", "3.18.2", "1.0.7", "1.0.3"] }],
  ["0.1.7-rc.1", { pins: ["4.0.4", "3.18.4", "1.0.9", "1.0.5"] }],
  ["0.1.7-rc.2", { pins: ["4.0.4", "3.18.4", "1.0.9", "1.0.5"] }],
  ["0.2.0-rc.1", { pins: ["4.0.4", "3.18.4", "1.0.9", "1.0.5"] }],
  ["0.2.0-rc.2", { pins: ["4.0.4", "3.18.4", "1.0.9", "1.0.5"] }],
  ["0.2.1-alpha.2", {
    pins: ["4.0.5-alpha.1", "3.18.5-alpha.1", "1.0.10-alpha.1", "1.0.6-alpha.1"],
    packages: workingDirectory,
  }],
  ["0.2.1-alpha.3", {
    pins: ["4.0.5-alpha.2", "3.18.5-alpha.2", "1.0.10-alpha.2", "1.0.6-alpha.2"],
    packages: workingDirectory,
  }],
  ["0.2.1-alpha.4", {
    pins: ["4.0.5-alpha.2", "3.18.5-alpha.2", "1.0.10-alpha.2", "1.0.6-alpha.2"],
    packages: workingDirectory,
  }],
  ["0.2.1-alpha.5", {
    pins: ["4.0.5-alpha.2", "3.18.5-alpha.2", "1.0.10-alpha.2", "1.0.6-alpha.2"],
    packages: workingDirectory,
  }],
  ["0.2.1-rc.1", { pins: ["4.0.5", "3.18.5", "1.0.10", "1.0.6"], packages: workingDirectory }],
  ["0.2.1-rc.2", { pins: ["4.0.5", "3.18.5", "1.0.10", "1.0.6"], packages: workingDirectory }],
  ["0.2.1-rc.3", { pins: ["4.0.5", "3.18.5", "1.0.10", "1.0.6"], packages: workingDirectory }],
  ["0.2.1-rc.4", { pins: ["4.0.5", "3.18.5", "1.0.10", "1.0.6"], packages: workingDirectory }],
  ["0.2.1-rc.5", { pins: ["4.0.5", "3.18.5", "1.0.10", "1.0.6"], packages: workingDirectory }],
  ["0.2.2-alpha.2", {
    pins: ["4.0.6-alpha.1", "3.18.6-alpha.1", "1.0.11-alpha.1", "1.0.7-alpha.1"],
    packages: splitExecutors,
  }],
  ["0.2.2-alpha.3", {
    pins: ["4.0.6-alpha.2", "3.18.6-alpha.2", "1.0.11-alpha.2", "1.0.7-alpha.2"],
    packages: splitExecutors,
  }],
  ["0.2.2-rc.1", { pins: ["4.1.0", "3.19.0", "1.1.0", "1.1.0"], packages: splitExecutors }],
  ["0.2.2-rc.2", { pins: ["4.1.0", "3.19.0", "1.1.0", "1.1.0"], packages: splitExecutors }],
  ["0.2.2-rc.3", { pins: ["4.1.0", "3.19.0", "1.1.0", "1.1.0"], packages: splitExecutors }],
  ["0.2.2-rc.4", {
    pins: ["4.1.0", "3.19.0", "1.1.0", "1.1.0"],
    packages: [...splitExecutors, "llm-deepseek"],
  }],
]);
export const SUPPORTED_HOSTS = Object.freeze([...HOSTS.keys()]);

export function createCompatManifest(original, version) {
  const host = HOSTS.get(version);
  if (host === undefined) {
    throw new Error(`Supported test hosts: ${SUPPORTED_HOSTS.join(", ")}`);
  }
  const manifest = structuredClone(original);
  manifest.private = true;
  if (manifest.scripts) delete manifest.scripts.prepack;
  manifest.devDependencies ??= {};
  delete manifest.devDependencies["@deepseek-ai/dsh-invariants"];
  delete manifest.devDependencies.tsdown;
  for (const name of Object.keys(manifest.devDependencies)) {
    if (name.startsWith("@deepseek-ai/dsh-")) manifest.devDependencies[name] = version;
  }
  if (host.legacyCodeRuntime) {
    delete manifest.devDependencies["@deepseek-ai/dsh-ptc-runtime"];
    manifest.devDependencies["@deepseek-ai/dsh-code-runtime"] = version;
  }
  const [cordis, schemastery, include, loader] = host.pins;
  Object.assign(manifest.devDependencies, {
    "@deepseek-ai/cordis": cordis,
    "@deepseek-ai/schemastery": schemastery,
    "@deepseek-ai/cordis-plugin-include": include,
    "@deepseek-ai/cordis-plugin-loader": loader,
  });
  for (const name of host.packages ?? []) {
    manifest.devDependencies[`@deepseek-ai/dsh-${name}`] = version;
  }
  return manifest;
}
