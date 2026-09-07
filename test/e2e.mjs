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
let activityNotifications = 0;
const server = new AgentServer(store, { port: 0, onActivity: () => { activityNotifications++; } });
const port = await server.start();
const base = `http://127.0.0.1:${port}`;
let passed = 0;

async function api(method, pathname, body, extraHeaders = {}) {
  const response = await fetch(base + pathname, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
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
    const result = await api("POST", "/api/nodes", { title: "发布窗口", content: "周五晚间不发布生产版本。", background: "2026 年发布节奏约定，供部署任务参考。", source: "agent" }, { "x-agentnote-agent-name": "Codex", "x-agentnote-session-title": encodeURIComponent("发布流程验证") });
    assert.equal(result.status, 201); assert.equal(result.data.type, "snippet"); assert.equal(result.data.background.includes("发布节奏"), true); textId = result.data.id;
    assert.equal(result.data.status, "created");
    assert.equal(activityNotifications, 1);
    assert.ok(result.data.link.startsWith(base)); assert.match(result.data.link, /\/api\/shares\/s-x-[0-9a-f]+\/resolve$/);
    textLink = result.data.link;
  });
  await test("legacy shares do not turn successful writes into failed responses", async () => {
    const sharesPath = path.join(vault, "agentNote", "data", "shares.json");
    const shares = JSON.parse(await fsp.readFile(sharesPath, "utf8"));
    shares.push({ id: "s-x-legacy", nodeId: textId, created: new Date().toISOString() });
    await fsp.writeFile(sharesPath, JSON.stringify(shares));
    const result = await api("POST", "/api/nodes", { title: "兼容性验证", content: "旧分享记录存在时也应正常返回。" });
    assert.equal(result.status, 201); assert.equal(result.ok, true); assert.ok(result.data.id); assert.ok(result.data.created); assert.ok(result.data.updated);
  });
  await test("idempotency key creates exactly one note", async () => {
    const payload = { title: "幂等写入", content: "重复请求不能重复创建。", idempotencyKey: "create-note-001" };
    const first = await api("POST", "/api/nodes", payload);
    const second = await api("POST", "/api/nodes", payload);
    assert.equal(first.ok, true); assert.equal(second.ok, true); assert.equal(second.data.id, first.data.id);
    const nodes = await api("GET", "/api/nodes?q=幂等写入"); assert.equal(nodes.data.length, 1);
  });
  await test("the write response link is the note's permanent address", async () => {
    const result = await api("GET", textLink.replace(base, ""), undefined, { "x-agentnote-agent-name": "Codex", "x-agentnote-session-title": encodeURIComponent("发布流程验证") });
    assert.equal(result.data.kind, "text"); assert.equal(result.data.content, "周五晚间不发布生产版本。");
    assert.ok(path.isAbsolute(result.data.filePath)); assert.match(result.data.hint, /优先通过本链接/);
  });
  await test("dashboard records successful link use and ranks reusable notes", async () => {
    const insights = await store.getDashboardInsights();
    assert.ok(insights.summary.weekResolves >= 1);
    assert.ok(insights.summary.weekUsedNotes >= 1);
    assert.equal(insights.weekly[0].node.id, textId);
    assert.match(insights.weekly[0].reason, /本周被读取/);
    assert.equal(insights.weeklyTrend.length, 7);
    assert.ok(insights.timeline.length >= 2);
    assert.equal(insights.timeline.find((event) => event.type === "share-resolved")?.actor?.name, "Codex");
    assert.equal(insights.timeline.find((event) => event.type === "share-resolved")?.actor?.sessionTitle, "发布流程验证");
  });
  await test("workstation insight APIs expose agent, document, and activity attribution", async () => {
    const activity = await api("GET", "/api/insights/activity?agent=Codex");
    assert.equal(activity.ok, true); assert.ok(activity.data.every((event) => event.actor?.name === "Codex"));
    const agents = await api("GET", "/api/insights/agents");
    assert.equal(agents.data.find((agent) => agent.name === "Codex").uses, 1);
    const documents = await api("GET", "/api/insights/documents");
    assert.equal(documents.data.find((document) => document.nodeId === textId).title, "发布窗口");
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
  await test("PATCH updates the archived state and returns the complete node", async () => {
    const result = await api("PATCH", `/api/nodes/${textId}`, { archived: true });
    assert.equal(result.status, 200); assert.equal(result.ok, true); assert.equal(result.data.archived, true); assert.equal(result.data.id, textId); assert.ok(result.data.updated);
    const listed = await api("GET", `/api/nodes?archived=true`); assert.ok(listed.data.some((node) => node.id === textId && node.archived));
    await api("PATCH", `/api/nodes/${textId}`, { archived: false });
  });
  await test("pinned notes stay out of archive recommendations", async () => {
    const stale = await store.createNode({ title: "待归档笔记", content: "不再使用的资料。" });
    const future = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    const before = await store.getDashboardInsights(future);
    assert.ok(before.archiveCandidates.some((node) => node.id === stale.id));
    const pinned = await store.updateNode(stale.id, { pinned: true });
    assert.equal(pinned.pinned, true);
    const after = await store.getDashboardInsights(future);
    assert.equal(after.archiveCandidates.some((node) => node.id === stale.id), false);
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
  await test("legacy activity records recover their document title from the share", async () => {
    const created = await api("POST", "/api/shares", { path: "plain.md" });
    const eventsPath = path.join(vault, "agentNote", "data", "events.json");
    const events = JSON.parse(await fsp.readFile(eventsPath, "utf8"));
    events.push({ type: "share-resolved", shareId: created.data.id, targetKind: "file", at: new Date().toISOString() });
    await fsp.writeFile(eventsPath, JSON.stringify(events));
    assert.equal((await store.listActivity()).find((event) => event.shareId === created.data.id)?.title, "plain");
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
    const prompt = renderSkillMd({ port, instructions: "使用中文。", agentName: "Codex" });
    assert.match(prompt, /写到 Obsidian/); assert.match(prompt, /agent 笔记/); assert.match(prompt, /background/); assert.match(prompt, /tags/); assert.match(prompt, /第一层文件名称/); assert.match(prompt, /filePath/); assert.match(prompt, /link/); assert.match(prompt, /X-AgentNote-Agent-Name: Codex/); assert.match(prompt, /X-AgentNote-Session-Title/); assert.doesNotMatch(prompt, /scenarios/);
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-home-")); await fsp.mkdir(path.join(home, ".codex"));
    const codex = detectAgents(home).find((agent) => agent.id === "codex"); installSkill(codex.skillDir, { port }); assert.ok(fs.existsSync(path.join(codex.skillDir, "SKILL.md"))); await fsp.rm(home, { recursive: true, force: true });
  });
  await test("built-in agents remain visible regardless of local installation", async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-agents-"));
    try {
      const agents = detectAgents(home);
      assert.deepEqual(agents.map((agent) => agent.id), ["claude-code", "codex", "workbuddy"]);
      assert.ok(agents.every((agent) => !agent.available && !agent.installed));
      assert.deepEqual(agents.map((agent) => agent.website), ["https://claude.com/product/claude-code", "https://openai.com/codex/", "https://www.workbuddy.cn/"]);
      assert.deepEqual(await fsp.readdir(home), []);
      await fsp.mkdir(path.join(home, ".codex"));
      assert.deepEqual(detectAgents(home).map((agent) => agent.available), [false, true, false]);
      const codex = detectAgents(home).find((agent) => agent.id === "codex");
      assert.equal(codex.installed, false);
      installSkill(codex.skillDir, { port });
      assert.equal(detectAgents(home).find((agent) => agent.id === "codex").installed, true);
    } finally {
      await fsp.rm(home, { recursive: true, force: true });
    }
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
