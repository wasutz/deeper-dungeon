#!/usr/bin/env node
// The SDK is consumed straight from https://github.com/spokesz/friendsdk, which keeps `dist/`
// out of version control and defines no `prepare` script. npm only runs `prepare` for git
// dependencies, so nothing builds the package during install and every `./dist/*` export
// resolves to a missing file. This builds it in place.
//
// The build runs against this project's own installed tree rather than an install of the SDK's:
// npm strips lockfiles when it packs a git dependency, so the SDK arrives without one and no
// `npm ci` is possible inside it. This project pins every version the SDK's build needs to the
// same exact version the SDK pins, so one lockfile -- ours -- covers both, no install runs on a
// deploy, and the toolchain that compiles the SDK is the one the lockfile resolved.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const sdk = new URL("node_modules/@rarefriends/friendsdk/", root);
const directory = fileURLToPath(sdk);

if (!existsSync(directory)) {
  console.error("@rarefriends/friendsdk is not installed; run npm ci first.");
  process.exit(1);
}

const read = url => JSON.parse(readFileSync(new URL("package.json", url), "utf8"));
const installed = name => {
  const url = new URL(`node_modules/${name}/`, root);
  return existsSync(fileURLToPath(new URL("package.json", url))) ? read(url).version : null;
};

// A pinned SDK dependency that this project does not pin identically would be compiled by a
// toolchain the SDK never chose. Ranges are the SDK's own peer contract and are left alone.
const manifest = read(sdk);
const pinned = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
  .filter(([, version]) => /^\d+\.\d+\.\d+$/.test(version));
const drifted = pinned.filter(([name, version]) => installed(name) !== version);

if (drifted.length > 0) {
  console.error("The SDK's build needs versions this project does not install:");
  for (const [name, version] of drifted) console.error(`  ${name}: SDK pins ${version}, installed ${installed(name) ?? "nothing"}`);
  console.error("Match them in package.json, then run npm install.");
  process.exit(1);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const { status } = spawnSync(npm, ["run", "build", "--prefix", directory], { stdio: "inherit" });
if (status !== 0) process.exit(status ?? 1);
