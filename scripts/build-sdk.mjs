#!/usr/bin/env node
// The SDK is consumed straight from https://github.com/spokesz/friendsdk, which keeps `dist/`
// out of version control and defines no `prepare` script. npm only runs `prepare` for git
// dependencies, so nothing builds the package during install and every `./dist/*` export
// resolves to a missing file. This builds it in place, using the SDK's own devDependencies so
// the result does not depend on hoisting from this project's tree.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sdk = fileURLToPath(new URL("../node_modules/@rarefriends/friendsdk", import.meta.url));

if (!existsSync(sdk)) {
  console.error("@rarefriends/friendsdk is not installed; run npm ci first.");
  process.exit(1);
}

// The SDK's build needs its devDependencies (TypeScript), which drag in Playwright. Its browser
// download is hundreds of megabytes that only the SDK's own browser checks use, and it is the
// step most likely to blow a CI or deploy install budget.
const environment = { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" };

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
for (const args of [["install", "--no-audit", "--no-fund"], ["run", "build"]]) {
  const { status } = spawnSync(npm, ["--prefix", sdk, ...args], { stdio: "inherit", env: environment });
  if (status !== 0) process.exit(status ?? 1);
}
