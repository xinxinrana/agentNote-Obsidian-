import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const { ActivityLog, VaultStore } = createRequire(import.meta.url)("./core-bundle.cjs");
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
  const baselineFiles = git("ls-files", "agentNote/data/events").split(/\r?\n/);
  const baselineBytes = await Promise.all(baselineFiles.map((file) => fs.readFile(path.join(repository, file))));

  git("switch", "-c", "mac");
  await mac.append({ type: "share-created", title: "Mac share" });
  commit("Mac operation");
  assert.match(git("diff", "--name-status", baseline, "HEAD"), /^A\s+agentNote\/data\/events\/\d{4}-\d{2}\/[a-f0-9-]+\.json$/);

  git("switch", "-c", "windows", "main");
  await windows.append({ type: "share-created", title: "Windows share" });
  commit("Windows operation");
  assert.match(git("diff", "--name-status", baseline, "HEAD"), /^A\s+agentNote\/data\/events\/\d{4}-\d{2}\/[a-f0-9-]+\.json$/);
  git("-c", "commit.gpgsign=false", "merge", "--no-edit", "mac");
  assert.equal(git("diff", "--name-only", "--diff-filter=U"), "");
  assert.equal(git("status", "--porcelain"), "");
  assert.equal((await mac.read()).length, 5);
  assert.equal((await windows.read()).length, 5);
  for (const [index, file] of baselineFiles.entries()) assert.deepEqual(await fs.readFile(path.join(repository, file)), baselineBytes[index]);
  assert.equal(await fs.readFile(legacyPath, "utf8"), legacy);
  git("-c", "commit.gpgsign=false", "merge", "--no-edit", "mac");
  assert.equal((await mac.read()).length, 5);

  git("switch", "-c", "share-base");
  const macStore = new VaultStore(repository, ".obsidian", { deviceIdFile: path.join(root, "mac-local", "device-id"), referencesFile: path.join(root, "mac-local", "references.json") });
  const windowsStore = new VaultStore(repository, ".obsidian", { deviceIdFile: path.join(root, "windows-local", "device-id"), referencesFile: path.join(root, "windows-local", "references.json") });
  await macStore.init();
  const note = await macStore.createNode({ title: "Shared note", content: "Shared content" });
  git("add", "agentNote");
  git("-c", "commit.gpgsign=false", "commit", "-m", "Share baseline");

  git("switch", "-c", "mac-shares");
  const macShare = await macStore.createShare(note.id);
  commit("Mac share");
  git("switch", "-c", "windows-shares", "share-base");
  const windowsShare = await windowsStore.createShare(note.id);
  commit("Windows share");
  git("-c", "commit.gpgsign=false", "merge", "--no-edit", "mac-shares");
  assert.equal(git("diff", "--name-only", "--diff-filter=U"), "");
  assert.equal(git("status", "--porcelain"), "");
  assert.equal((await windowsStore.listShares()).length, 2);
  assert.equal((await windowsStore.resolveShare(macShare.id)).content, "Shared content");
  assert.equal((await windowsStore.resolveShare(windowsShare.id)).content, "Shared content");
  assert.deepEqual((await fs.readdir(path.join(data, "shares"))).sort(), [`${macShare.id}.json`, `${windowsShare.id}.json`].sort());
  const oldDocuments = JSON.stringify([{ id: "d-old", path: "old.md", title: "Old", created: "2025-01-01T00:00:00Z", updated: "2025-01-01T00:00:00Z" }]);
  const oldReferences = JSON.stringify({ "old.md": [] });
  await fs.writeFile(path.join(data, "documents.json"), oldDocuments);
  await fs.writeFile(path.join(data, "references.json"), oldReferences);
  commit("Legacy indexes");
  const indexBase = git("rev-parse", "HEAD");
  git("switch", "-c", "mac-indexes");
  await macStore.registerAgent({ id: "mac", name: "Mac Agent" });
  await macStore.createNode({ title: "Mac keyed note" }, "mac-key");
  await macStore.recordLocalActivity("local-read", "old.md");
  await macStore.recordDocumentReferences("old.md", []);
  git("add", "agentNote");
  git("-c", "commit.gpgsign=false", "commit", "-m", "Mac state");
  git("switch", "-c", "windows-indexes", indexBase);
  await windowsStore.registerAgent({ id: "windows", name: "Windows Agent" });
  await windowsStore.createNode({ title: "Windows keyed note" }, "windows-key");
  await windowsStore.recordLocalActivity("local-read", "old.md");
  await windowsStore.recordDocumentReferences("old.md", []);
  git("add", "agentNote");
  git("-c", "commit.gpgsign=false", "commit", "-m", "Windows state");
  git("-c", "commit.gpgsign=false", "merge", "--no-edit", "mac-indexes");
  assert.equal(git("diff", "--name-only", "--diff-filter=U"), "");
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(await fs.readFile(path.join(data, "documents.json"), "utf8"), oldDocuments);
  assert.equal(await fs.readFile(path.join(data, "references.json"), "utf8"), oldReferences);
  assert.equal((await windowsStore.resolveActivityContext({ actor: { id: "mac", name: "Unregistered" } })).actor.name, "Mac Agent");
  assert.equal((await windowsStore.resolveActivityContext({ actor: { id: "windows", name: "Unregistered" } })).actor.name, "Windows Agent");
  assert.equal((await windowsStore.listNodes()).length, 3);
  assert.equal((await windowsStore.listActivity()).filter((event) => event.type === "local-read" && event.path === "old.md").length, 2);
  console.log("Git sync passed: independent events, shares, identities, and keyed writes merge without conflicts; legacy indexes remain unchanged.");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
