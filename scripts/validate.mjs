#!/usr/bin/env node
/**
 * Validates the app package before upload/publish.
 * Fail-fast philosophy: collects EVERY issue and prints them all at once.
 *
 *   npm run validate
 *
 * Checks:
 *  1. app.json parses and satisfies the manifest contract (schema/app.v1.json)
 *  2. referenced files exist (icon, entry in dist/ when built)
 *  3. no absolute /api calls in src/ (apps must call relative ./api/…)
 *  4. no hardcoded credentials in src/ or dist/
 *  5. no VITE_-prefixed secrets in .env files (VITE_ vars are inlined into
 *     the public bundle)
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const issues = [];
const warn = [];

// ---------- 1. manifest ----------
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(join(root, "app.json"), "utf8"));
} catch (e) {
  issues.push(`app.json: cannot read/parse — ${e.message}`);
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

if (manifest) {
  const req = (cond, msg) => { if (!cond) issues.push(`app.json: ${msg}`); };

  req(typeof manifest.id === "string" && SLUG.test(manifest.id) && manifest.id.length <= 64,
    `"id" must be a kebab-case slug (got ${JSON.stringify(manifest.id)})`);
  if (manifest.id === "my-cortex-app") {
    warn.push(`"id" is still the template placeholder — pick your app's real id before publishing`);
  }
  req(manifest.id !== "launch", `"id": "launch" is reserved (Cortex launcher routing)`);
  req(typeof manifest.name === "string" && manifest.name.length >= 1 && manifest.name.length <= 80,
    `"name" is required (1–80 chars)`);
  req(typeof manifest.version === "string" && SEMVER.test(manifest.version),
    `"version" must be semver (got ${JSON.stringify(manifest.version)})`);
  req(["static", "platform", "service"].includes(manifest.type),
    `"type" must be static | platform | service`);
  req(typeof manifest.description === "string" && manifest.description.length >= 1 && manifest.description.length <= 200,
    `"description" is required (1–200 chars)`);
  req(manifest.publisher && typeof manifest.publisher.name === "string" && manifest.publisher.name.length > 0,
    `"publisher.name" is required`);
  req(typeof manifest.icon === "string" && manifest.icon.endsWith(".svg"),
    `"icon" must point to an SVG`);
  if (manifest.icon) req(existsSync(join(root, manifest.icon)), `icon file "${manifest.icon}" not found`);

  const c = manifest.cortex;
  req(c && typeof c === "object", `"cortex" block is required`);
  if (c) {
    req(typeof c.minVersion === "string", `"cortex.minVersion" is required`);
    req(["read", "read_write"].includes(c.keyScope), `"cortex.keyScope" must be read | read_write`);
    req(Array.isArray(c.endpoints) && c.endpoints.length > 0 &&
        c.endpoints.every((e) => typeof e === "string" && !e.startsWith("/")),
      `"cortex.endpoints" must be a non-empty array of paths relative to /api/ (no leading slash)`);
    req(c.collections === "user-selected" || c.collections === "all" ||
        (Array.isArray(c.collections) && c.collections.length > 0),
      `"cortex.collections" must be "user-selected" | "all" | [names]`);
  }

  if (manifest.type === "service") {
    req(manifest.service && typeof manifest.service.image === "string",
      `service apps require "service.image"`);
  } else {
    req(typeof manifest.entry === "string" && manifest.entry.endsWith(".html"),
      `"entry" (an .html file inside dist/) is required for ${manifest.type} apps`);
    req(!manifest.service, `"service" block is only valid for type: "service"`);
    if (existsSync(join(root, "dist"))) {
      req(existsSync(join(root, "dist", manifest.entry ?? "index.html")),
        `dist/${manifest.entry} not found — did the build succeed?`);
    } else {
      warn.push(`dist/ not built yet — entry check skipped (run: npm run build)`);
    }
  }

  if (manifest.capabilities && manifest.type !== "platform") {
    issues.push(`app.json: "capabilities" is only valid for type: "platform"`);
  }
  if (manifest.capabilities?.http) {
    const hosts = manifest.capabilities.http.hosts;
    if (!Array.isArray(hosts) || hosts.length === 0) {
      issues.push(`app.json: "capabilities.http.hosts" must list every external host the server may call`);
    }
  }
  for (const v of manifest.config ?? []) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(v.name ?? "")) {
      issues.push(`app.json: config var ${JSON.stringify(v.name)} must be UPPER_SNAKE`);
    }
    if (!["text", "secret"].includes(v.type)) {
      issues.push(`app.json: config var ${v.name}: "type" must be text | secret`);
    }
  }
}

// ---------- 2–4. source scans ----------
const SCAN_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".html", ".css", ".mjs"]);
const files = [];
(function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (SCAN_EXT.has(extname(name))) files.push(p);
  }
})(join(root, "src"));
(function walkDist(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkDist(p);
    else if ([".js", ".html", ".css"].includes(extname(name))) files.push(p);
  }
})(join(root, "dist"));

const ABSOLUTE_API = /["'`]\/api\//;
const CREDENTIALS = [
  [/moca_(admin|manage|read)_[A-Za-z0-9]/, "a Cortex API key"],
  [/sk-[A-Za-z0-9]{20}/, "an OpenAI-style API key"],
  [/Bearer\s+[A-Za-z0-9_-]{20}/, "a hardcoded bearer token"],
];

for (const f of files) {
  const rel = f.slice(root.length);
  const text = readFileSync(f, "utf8");
  if (ABSOLUTE_API.test(text)) {
    issues.push(`${rel}: absolute "/api/…" call — apps must use relative paths ("./api/…") so they work under /apps/{slug}/ (use the client in src/lib/cortex.ts)`);
  }
  for (const [re, what] of CREDENTIALS) {
    if (re.test(text)) issues.push(`${rel}: looks like ${what} is hardcoded — credentials must never ship in an app bundle`);
  }
}

// ---------- 5. env hygiene ----------
for (const envName of [".env", ".env.local", ".env.production"]) {
  const p = join(root, envName);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^(VITE_[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*)=/);
    if (m) issues.push(`${envName}: ${m[1]} — VITE_-prefixed vars are inlined into the public bundle; secrets must not use the VITE_ prefix`);
  }
}

// ---------- report ----------
for (const w of warn) console.log(`  ⚠ ${w}`);
if (issues.length) {
  console.error(`\n✗ validation failed with ${issues.length} issue(s):\n`);
  for (const i of issues) console.error(`  • ${i}`);
  console.error();
  process.exit(1);
}
console.log(`✓ app.json and sources look good (${manifest.id}@${manifest.version}, type: ${manifest.type})`);
