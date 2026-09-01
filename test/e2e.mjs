import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { VaultStore, AgentServer, detectAgents, installSkill, renderSkillMd, renderManualInstallPrompt, isNewerVersion } = require("./core-bundle.cjs");

const vault = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-e2e-"));
const store = new VaultStore(vault);
const server = new AgentServer(store, { port: 0 });
const port = await server.start();
const base = `http://127.0.0.1:${port}`;
let passed = 0;

async function api(method, pathname, body) {
  const response = await fetch(base + pathname, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = response.headers.get("content-type")?.includes("application/json") ? await response.json() : await response.text();
  return { status: response.status, ...data };
}
async function test(name, fn) { await fn(); passed++; console.log(`✓ ${name}`); }

try {
  await test("health exposes the local sharing service", async () => {
    const result = await api("GET", "/api/health");
    assert.equal(result.status, 200); assert.equal(result.data.version, 2);
  });

  let textId, textLink;
  await test("agent writes a normal note from a natural-language intent", async () => {
    const result = await api("POST", "/api/nodes", { title: "发布窗口", content: "周五晚间不发布生产版本。", background: "2026 年发布节奏约定，供部署任务参考。", source: "agent" });
    assert.equal(result.status, 201); assert.equal(result.data.type, "snippet"); assert.equal(result.data.background.includes("发布节奏"), true); textId = result.data.id;
    assert.equal(result.data.status, "created");
    assert.ok(result.data.link.startsWith(base)); assert.match(result.data.link, /\/api\/shares\/s-x-[0-9a-f]+\/resolve$/);
    textLink = result.data.link;
  });
  await test("the write response link is the note's permanent address", async () => {
    const result = await api("GET", textLink.replace(base, ""));
    assert.equal(result.data.kind, "text"); assert.equal(result.data.content, "周五晚间不发布生产版本。");
    assert.ok(path.isAbsolute(result.data.filePath)); assert.match(result.data.hint, /优先通过本链接/);
  });
  await test("text share resolves to body plus background", async () => {
    const created = await api("POST", "/api/shares", { nodeId: textId });
    const result = await api("GET", `/api/shares/${created.data.id}/resolve`);
    assert.equal(result.data.kind, "text"); assert.equal(result.data.content, "周五晚间不发布生产版本。"); assert.match(result.data.background, /发布节奏/);
  });
  await test("updating a note returns the same permanent link", async () => {
    const result = await api("PATCH", `/api/nodes/${textId}`, { content: "周五全天不发布生产版本。" });
    assert.equal(result.data.status, "updated"); assert.equal(result.data.link, textLink);
    const resolved = await api("GET", textLink.replace(base, "")); assert.match(resolved.data.content, /周五全天/);
  });

  await test("file share resolves to address, background, and current content", async () => {
    const file = path.join(vault, "deploy.md"); await fsp.writeFile(file, "# Deploy\n\nrun migration first", "utf8");
    const node = await api("POST", "/api/nodes", { type: "file", title: "部署说明", path: file, background: "部署操作的入口文件。" });
    const created = await api("POST", "/api/shares", { nodeId: node.data.id });
    const result = await api("GET", `/api/shares/${created.data.id}/resolve`);
    assert.equal(result.data.kind, "file"); assert.equal(result.data.address, file); assert.match(result.data.content, /migration/); assert.match(result.data.background, /入口/); assert.equal(result.data.filePath, file);
  });

  await test("folder share resolves to address, background, and first-level entries", async () => {
    const folder = path.join(vault, "project"); await fsp.mkdir(path.join(folder, "nested"), { recursive: true }); await fsp.writeFile(path.join(folder, "README.md"), "x"); await fsp.writeFile(path.join(folder, "nested", "hidden.md"), "x");
    const node = await api("POST", "/api/nodes", { type: "folder", title: "项目目录", path: folder, background: "项目资料的入口。" });
    const created = await api("POST", "/api/shares", { nodeId: node.data.id });
    const result = await api("GET", `/api/shares/${created.data.id}/resolve`);
    assert.deepEqual(result.data.entries, ["nested/", "README.md"].sort((a, b) => a.localeCompare(b))); assert.equal(result.data.entries.includes("nested/hidden.md"), false); assert.equal(result.data.address, folder);
    assert.equal(result.data.filePath, folder);
  });

  await test("direct vault file sharing needs no user-entered background", async () => {
    await fsp.writeFile(path.join(vault, "plain.md"), "plain body");
    const created = await api("POST", "/api/shares", { path: "plain.md" });
    const result = await api("GET", `/api/shares/${created.data.id}/resolve`);
    assert.equal(result.data.kind, "file"); assert.equal(result.data.address, "plain.md"); assert.equal(result.data.background, "");
  });

  await test("archive is a folder move and does not break an existing share", async () => {
    const share = await api("POST", "/api/shares", { nodeId: textId });
    const archived = await api("POST", `/api/nodes/${textId}/archive`, { archived: true });
    assert.equal(archived.data.archived, true);
    assert.ok(fs.existsSync(path.join(vault, "agentNote", "nodes", "归档", "发布窗口.md")));
    const resolved = await api("GET", `/api/shares/${share.data.id}/resolve`); assert.equal(resolved.status, 200);
    const restored = await api("POST", `/api/nodes/${textId}/archive`, { archived: false }); assert.equal(restored.data.archived, false);
  });

  await test("installed agent prompt recognizes writing to Obsidian and correct share forms", async () => {
    const prompt = renderSkillMd({ port, instructions: "使用中文。" });
    assert.match(prompt, /写到 Obsidian/); assert.match(prompt, /agent 笔记/); assert.match(prompt, /background/); assert.match(prompt, /tags/); assert.match(prompt, /第一层文件名称/); assert.match(prompt, /filePath/); assert.match(prompt, /link/); assert.doesNotMatch(prompt, /scenarios/);
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-home-")); await fsp.mkdir(path.join(home, ".codex"));
    const [codex] = detectAgents(home); installSkill(codex.skillDir, { port }); assert.ok(fs.existsSync(path.join(codex.skillDir, "SKILL.md"))); await fsp.rm(home, { recursive: true, force: true });
  });
  await test("manual installation prompt is portable and asks the target agent to verify", async () => {
    const prompt = renderManualInstallPrompt({ port });
    assert.match(prompt, /不要假设/); assert.match(prompt, /GET http:\/\/127\.0\.0\.1/); assert.match(prompt, /自行验证/); assert.match(prompt, /写到 Obsidian/); assert.match(prompt, /filePath/);
  });

  await test("version comparison drives self-update decisions", async () => {
    assert.equal(isNewerVersion("0.2.0", "0.1.0"), true);
    assert.equal(isNewerVersion("v0.10.0", "0.9.9"), true);
    assert.equal(isNewerVersion("0.1.0", "0.1.0"), false);
    assert.equal(isNewerVersion("0.1", "0.1.1"), false);
    assert.equal(isNewerVersion("1.0.0", "v2.0.0"), false);
  });

  console.log(`\n${passed} passed`);
} finally {
  await server.stop();
  await fsp.rm(vault, { recursive: true, force: true });
}
