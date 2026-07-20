#!/usr/bin/env node
/**
 * Packages the built app into {id}-{version}.zip — the format cortex-app's
 * installer and the registry consume:
 *
 *   app.json      manifest
 *   icon.svg      (whatever "icon" points to)
 *   dist/**       built static assets ("entry" lives in here)
 *
 * Run via: npm run package   (build + validate + zip)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { zipSync } from "fflate";

const root = new URL("..", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(root, "app.json"), "utf8"));

const SIZE_CAP = 50 * 1024 * 1024; // 50 MB, matching the installer's cap

if (manifest.type === "service") {
  console.error("✗ service apps are distributed as container images + compose templates, not zips.");
  process.exit(1);
}
if (!existsSync(join(root, "dist", manifest.entry))) {
  console.error(`✗ dist/${manifest.entry} not found — run the build first (npm run package does this for you)`);
  process.exit(1);
}

const files = {};
files["app.json"] = readFileSync(join(root, "app.json"));
files[manifest.icon] = readFileSync(join(root, manifest.icon));

(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files[relative(root, p)] = readFileSync(p);
  }
})(join(root, "dist"));

const zipped = zipSync(files, { level: 9 });
if (zipped.length > SIZE_CAP) {
  console.error(`✗ package is ${(zipped.length / 1024 / 1024).toFixed(1)} MB — exceeds the 50 MB cap`);
  process.exit(1);
}

const out = join(root, `${manifest.id}-${manifest.version}.zip`);
writeFileSync(out, zipped);
console.log(`✓ ${manifest.id}-${manifest.version}.zip (${(zipped.length / 1024).toFixed(0)} KB, ${Object.keys(files).length} files)`);
console.log(`  → upload it in your Cortex admin panel (Apps → Install), or publish via cortex-registry`);
