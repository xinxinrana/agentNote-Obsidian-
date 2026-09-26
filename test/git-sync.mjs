import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const { ActivityLog } = createRequire(import.meta.url)("./core-bundle.cjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentnote-git-sync-"));
const repository = path.join(root, "vault");
const data = path.join(repository, "agentNote", "data");
const git = (...args) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (message) => {
  git("add", "agentNote/data");
  git("-c", "commit.gpgsign=false", "commit", "-m", message);
};

try {
  await fs.mkdir(data, { recursive: true });
  git("init", "-b", "main");
  git("config", "user.name", "agentNote test");
  git("config", "user.email", "agentnote-test@example.invalid");
  git("config", "core.autocrlf", "false");
  const mac = new ActivityLog(data, { deviceIdFile: path.join(root, "mac-local", "device-id") });
  const windows = new ActivityLog(data, { deviceIdFile: path.join(root, "windows-local", "device-id") });
  await mac.append({ type: "local-read", title: "Mac baseline" });
  await windows.append({ type: "local-read", title: "Windows baseline" });
  const legacyPath = path.join(data, "events.json");
  const legacy = JSON.stringify([{ at: "2025-01-01T00:00:00.000Z", type: "local-read", title: "Legacy history" }]);
  await fs.writeFile(legacyPath, legacy);
  commit("Shared baseline");
  const baseline = git("rev-parse", "HEAD");
  const macFile = await mac.filePath();
  const windowsFile = await windows.filePath();
  const macBefore = JSON.parse(await fs.readFile(macFile, "utf8"));
  const windowsBefore = JSON.parse(await fs.readFile(windowsFile, "utf8"));

  git("switch", "-c", "mac");
  await mac.append({ type: "share-created", title: "Mac share" });
  commit("Mac operation");
  assert.equal(git("diff", "--name-status", baseline, "HEAD"), `M\tagentNote/data/${path.basename(macFile)}`);

  git("switch", "-c", "windows", "main");
  await windows.append({ type: "share-created", title: "Windows share" });
  commit("Windows operation");
  assert.equal(git("diff", "--name-status", baseline, "HEAD"), `M\tagentNote/data/${path.basename(windowsFile)}`);
  git("-c", "commit.gpgsign=false", "merge", "--no-edit", "mac");
  assert.equal(git("diff", "--name-only", "--diff-filter=U"), "");
  assert.equal(git("status", "--porcelain"), "");
  assert.equal((await mac.read()).length, 5);
  assert.equal((await windows.read()).length, 5);
  assert.deepEqual(JSON.parse(await fs.readFile(macFile, "utf8")).slice(0, 1), macBefore);
  assert.deepEqual(JSON.parse(await fs.readFile(windowsFile, "utf8")).slice(0, 1), windowsBefore);
  assert.equal(await fs.readFile(legacyPath, "utf8"), legacy);
  git("-c", "commit.gpgsign=false", "merge", "--no-edit", "mac");
  assert.equal((await mac.read()).length, 5);
  console.log("Git sync passed: both devices modify separate existing logs, merge without conflicts, preserve history, and count each event once.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
