// Sets the same version in package.json, src-tauri/tauri.conf.json and
// src-tauri/Cargo.toml, so the updater compares apples to apples.
//   node tools/set-version.mjs 0.2.0
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: node tools/set-version.mjs <semver>   e.g. 0.2.0");
  process.exit(1);
}

function editJson(path) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  json.version = version;
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  console.log(`${path}: ${version}`);
}
editJson("package.json");
editJson("src-tauri/tauri.conf.json");

const cargoPath = "src-tauri/Cargo.toml";
const cargo = readFileSync(cargoPath, "utf8");
const updated = cargo.replace(/^(\[package\][\s\S]*?^version\s*=\s*")[^"]*(")/m, `$1${version}$2`);
if (updated === cargo) {
  console.error(`${cargoPath}: could not find [package] version`);
  process.exit(1);
}
writeFileSync(cargoPath, updated);
console.log(`${cargoPath}: ${version}`);
console.log(`\nnext:\n  git commit -am "release v${version}"\n  git tag v${version}\n  git push && git push --tags`);
