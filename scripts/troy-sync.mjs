// Runs at container start, before the wrapper (see Dockerfile CMD).
//
// Pulls the Troy workout agent's code from GitHub and installs it on the
// /data volume, so a push to that repo plus a restart updates the bot. Only
// code files are copied; logged data (data/*.jsonl, session.json) is never
// touched. The new code's own tests must pass first, and the files it
// replaces are backed up to /data/backup-sync/<time>/.
//
// Best effort: any failure is logged and the bot starts with what it had.
// Set TROY_SYNC=0 to turn it off.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";

const REPO = process.env.TROY_REPO || "tacro506/troy-workout-agent";
const REF = process.env.TROY_REF || "main";
const WS = process.env.OPENCLAW_WORKSPACE_DIR?.trim() || "/data/workspace";
const DATA_ROOT = process.env.TROY_DATA_ROOT || "/data";
const PLUGIN_DIR = path.join(DATA_ROOT, "plugins/troy-buttons");
const BACKUP_ROOT = path.join(DATA_ROOT, "backup-sync");
const KEEP_BACKUPS = 5;
// Bump when this script starts installing differently, so the next start
// re-installs even if the repo commit is unchanged.
const SYNC_VERSION = 2;
const STATUS_FILE = path.join(DATA_ROOT, "troy-sync.json");
const PYTHON = process.env.TROY_PYTHON || "python3";
// Read-only GitHub token (fine-grained, Contents: read) -- needed while the
// repo is private. Set it as a Railway variable; never commit it.
const TOKEN = process.env.TROY_GITHUB_TOKEN?.trim();
// Testing aid: install from this local checkout instead of downloading.
const SRC_DIR = process.env.TROY_SRC_DIR;

// [path in the repo, destination on the volume]. The repo's own
// deploy/sync-files.json overrides this list when present.
const DEFAULT_FILES = [
  ["skills/workout-tracker/log.py", path.join(WS, "skills/workout-tracker/log.py")],
  ["skills/workout-tracker/SKILL.md", path.join(WS, "skills/workout-tracker/SKILL.md")],
  ["workspace/AGENTS.md", path.join(WS, "AGENTS.md")],
  ["data/program.json", path.join(WS, "data/program.json")],
  ["plugins/troy-buttons/index.js", path.join(PLUGIN_DIR, "index.js")],
  ["plugins/troy-buttons/openclaw.plugin.json", path.join(PLUGIN_DIR, "openclaw.plugin.json")],
  ["plugins/troy-buttons/package.json", path.join(PLUGIN_DIR, "package.json")],
];

const log = (msg) => console.log(`[troy-sync] ${msg}`);

// Read deploy/sync-files.json ({"files": {"repo/path": "{workspace}/..."}}).
// Destinations must stay inside the volume and never be logged data.
function resolveFiles(src) {
  const manifest = path.join(src, "deploy/sync-files.json");
  if (!fs.existsSync(manifest)) return DEFAULT_FILES;
  const { files } = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const out = [];
  for (const [rel, template] of Object.entries(files)) {
    const dest = path.resolve(template.replace("{workspace}", WS).replace("{data}", DATA_ROOT));
    const inside = [WS, DATA_ROOT].some((root) => dest.startsWith(path.resolve(root) + path.sep));
    if (!inside || rel.includes("..") || /\.jsonl$|session\.json$/.test(dest)) {
      log(`ignoring unsafe sync entry ${rel} -> ${template}`);
      continue;
    }
    out.push([rel, dest]);
  }
  return out;
}

function githubHeaders(accept) {
  return { Accept: accept, "User-Agent": "troy-sync", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function latestSha() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${REF}`, {
    headers: githubHeaders("application/vnd.github.sha"),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 404 && !TOKEN) throw new Error("GitHub commit lookup: HTTP 404 (private repo? set TROY_GITHUB_TOKEN)");
  if (!res.ok) throw new Error(`GitHub commit lookup: HTTP ${res.status}`);
  return (await res.text()).trim();
}

async function download(sha, dir) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/tarball/${sha}`, {
    headers: githubHeaders("application/vnd.github+json"),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`download: HTTP ${res.status}`);
  const file = path.join(dir, "repo.tgz");
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const src = path.join(dir, "src");
  fs.mkdirSync(src);
  await tar.x({ file, cwd: src, strip: 1 });
  return src;
}

function runTests(src) {
  const opts = { cwd: src, stdio: "pipe", timeout: 180000, encoding: "utf8", env: { ...process.env, TROY_PYTHON: PYTHON } };
  const tests = fs.readdirSync(path.join(src, "tests")).filter((f) => /^test_.*\.py$/.test(f)).sort();
  for (const t of tests) execFileSync(PYTHON, [path.join("tests", t)], opts);
  if (fs.existsSync(path.join(src, "plugins/troy-buttons/test.mjs"))) {
    execFileSync(process.execPath, ["plugins/troy-buttons/test.mjs"], opts);
  }
}

function backup(stamp, files) {
  const dir = path.join(BACKUP_ROOT, stamp);
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  for (const [, dest] of files) {
    if (!fs.existsSync(dest)) continue;
    const to = path.join(dir, path.relative(DATA_ROOT, dest));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(dest, to);
  }
  const all = fs.readdirSync(BACKUP_ROOT).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) {
    fs.rmSync(path.join(BACKUP_ROOT, old), { recursive: true, force: true });
  }
}

function install(src, files) {
  for (const [rel, dest] of files) {
    const from = path.join(src, rel);
    if (!fs.existsSync(from)) {
      log(`skipping ${rel} (not in repo)`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.sync-tmp`;
    fs.copyFileSync(from, tmp);
    fs.renameSync(tmp, dest);
  }
}

// One-time: register the plugin with OpenClaw (a linked install, so later
// syncs update it in place).
function ensurePlugin() {
  if (!fs.existsSync(path.join(PLUGIN_DIR, "index.js"))) return;
  const opts = { stdio: "pipe", timeout: 90000, encoding: "utf8" };
  try {
    execFileSync("openclaw", ["plugins", "inspect", "troy-buttons", "--json"], opts);
    return;
  } catch {
    // not installed yet
  }
  try {
    execFileSync("openclaw", ["plugins", "install", "--link", PLUGIN_DIR, "--force", "--accept-capabilities"], opts);
    log("installed troy-buttons plugin");
  } catch (error) {
    log(`plugin install failed (taps will use the agent): ${String(error.stderr || error.message).slice(0, 500)}`);
  }
}

async function main() {
  if (process.env.TROY_SYNC === "0") return log("disabled (TROY_SYNC=0)");

  const sha = SRC_DIR ? "local" : await latestSha();
  const status = readStatus();
  const installed = status.files || DEFAULT_FILES.map(([, dest]) => dest);
  if (status.sha === sha && status.syncVersion === SYNC_VERSION && installed.every((dest) => fs.existsSync(dest))) {
    log(`up to date at ${sha.slice(0, 7)}`);
    ensurePlugin();
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "troy-sync-"));
  try {
    const src = SRC_DIR || (await download(sha, tmp));
    try {
      runTests(src);
    } catch (error) {
      log(`tests failed for ${sha.slice(0, 7)}; keeping the current files`);
      log(String(error.stdout || "").slice(-1500) + String(error.stderr || "").slice(-1500));
      return;
    }
    const files = resolveFiles(src);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backup(stamp, files);
    install(src, files);
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      sha, syncVersion: SYNC_VERSION, ref: REF, repo: REPO, syncedAt: new Date().toISOString(), backup: stamp, files: files.map(([, dest]) => dest),
    }, null, 1));
    log(`installed ${REPO}@${sha.slice(0, 7)} (was ${status.sha ? status.sha.slice(0, 7) : "unsynced"})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  ensurePlugin();
}

main().catch((error) => log(`failed, starting with the current files: ${error.message}`));
