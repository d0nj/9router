import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_FILES = ["package.json", "cli/package.json"];
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const version = process.argv[2];

if (!version || !SEMVER.test(version)) {
  console.error(`Expected a semantic version argument, got ${version ?? "<none>"}`);
  process.exit(1);
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

for (const file of PACKAGE_FILES) {
  const filePath = path.join(repoRoot, file);
  const manifest = JSON.parse(readFileSync(filePath, "utf8"));
  manifest.version = version;
  writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${file} -> ${version}`);
}
