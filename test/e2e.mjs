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
const liveActivities = [];
const server = new AgentServer(store, { port: 0, onActivity: (activity) => { activityNotifications++; liveActivities.push(activity); } });
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
    assert.equal(liveActivities.at(-1)?.operation, "created");
    assert.equal(liveActivities.at(-1)?.title, "发布窗口");
    assert.equal(liveActivities.at(-1)?.actor?.name, "Codex");
    assert.equal(liveActivities.at(-1)?.actor?.sessionTitle, "发布流程验证");
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
    assert.equal(liveActivities.at(-1)?.operation, "read");
    assert.equal(liveActivities.at(-1)?.title, "发布窗口");
  });
  await test("dashboard records successful link use and ranks reusable notes", async () => {
    const insights = await store.getDashboardInsights();
    assert.ok(insights.summary.weekResolves >= 1);
    assert.ok(insights.summary.weekUsedNotes >= 1);
    assert.equal(insights.weekly[0].node.id, textId);
    assert.match(insights.weekly[0].reason, /本周被读取/);
    assert.equal(insights.weeklyTrend.length, 7);
    assert.ok(insights.allTimeTrend.length >= 358 && insights.allTimeTrend.length <= 364);
    assert.ok(insights.startedAt);
    assert.ok(insights.timeline.length >= 2);
    assert.equal(insights.timeline.find((event) => event.type === "share-resolved")?.actor?.name, "Codex");
    assert.equal(insights.timeline.find((event) => event.type === "share-resolved")?.actor?.sessionTitle, "发布流程验证");
  });
  await test("dashboard counts creation, updates, sharing, and reuse with transparent weights", async () => {
    const scoringVault = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-score-"));
    const scoringStore = new VaultStore(scoringVault);
    try {
      await scoringStore.init();
      const node = await scoringStore.createNode({ title: "统计样本", content: "用于验证知识活跃分。" });
      await scoringStore.updateNode(node.id, { content: "用于验证知识活跃分与维护行为。" });
      const share = await scoringStore.createShare(node.id);
      await scoringStore.resolveShare(share.id);
      const insights = await scoringStore.getDashboardInsights();
      assert.equal(insights.summary.weekActivityScore, 12);
      assert.equal(insights.summary.allTimeActivityScore, 12);
      assert.equal(insights.summary.weekActivityCount, 4);
      assert.equal(insights.summary.weekCreated, 1);
      assert.equal(insights.summary.weekUpdated, 1);
      assert.equal(insights.summary.weekSharesCreated, 1);
      assert.equal(insights.summary.weekResolves, 1);
      assert.equal(insights.timeline.find((event) => event.type === "share-resolved")?.origin, "link");
      assert.ok(insights.timeline.some((event) => event.type === "share-created" && event.title === "统计样本"));
      assert.equal(insights.weeklyTrend.reduce((total, point) => total + point.count, 0), 12);
      const later = await scoringStore.getDashboardInsights(new Date("2027-01-02T12:00:00"));
      assert.equal(later.allTimeTrend.length, 364);
      assert.equal(later.allTimeTrend[0].label, "2026-01-04");
      assert.equal(later.allTimeTrend.at(-1).label, "2027-01-02");
      assert.equal(later.summary.allTimeActivityScore, 12);
    } finally {
      await fsp.rm(scoringVault, { recursive: true, force: true });
    }
  });
  await test("registered agent identity overrides a changing self-reported name", async () => {
    await store.registerAgent({ id: "codex", name: "Codex" });
    const result = await api("POST", "/api/nodes", { title: "身份稳定性", content: "固定配置优先于请求中的显示名称。" }, { "x-agentnote-agent-id": "codex", "x-agentnote-agent-name": encodeURIComponent("随机名称"), "x-agentnote-session-title": encodeURIComponent("身份验证") });
    assert.equal(result.status, 201);
    const created = (await store.listActivity({ nodeId: result.data.id })).find((event) => event.type === "node-created");
    assert.equal(created?.actor?.id, "codex");
    assert.equal(created?.actor?.name, "Codex");
    assert.equal(created?.actor?.sessionTitle, "身份验证");
    assert.equal(created?.title, "身份稳定性");
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
  await test("PATCH updates shared text through its scoped share API", async () => {
    const shareId = textLink.split("/").at(-2);
    const result = await api("PATCH", `/api/shares/${shareId}`, { content: "周五至周日不发布生产版本。" });
    assert.equal(result.status, 200); assert.equal(result.data.kind, "text"); assert.match(result.data.content, /周五至周日/);
    const resolved = await api("GET", textLink.replace(base, "")); assert.match(resolved.data.content, /周五至周日/);
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
    const updated = await api("PATCH", `/api/shares/${created.data.id}`, { content: "updated through the share API" });
    assert.equal(updated.status, 200); assert.equal(updated.data.content, "updated through the share API");
    assert.equal(await fsp.readFile(path.join(vault, "plain.md"), "utf8"), "updated through the share API");
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

  await test("local document activity keeps a stable history through organization and deletion", async () => {
    const localPath = "工作/协作记录.md";
    assert.equal(await store.recordLocalActivity("local-created", localPath), true);
    assert.equal(await store.recordLocalActivity("local-edited", localPath), true);
    assert.equal(await store.recordLocalActivity("local-read", localPath), true);
    const movedPath = "工作/已完成/协作记录.md";
    assert.equal(await store.recordLocalActivity("local-moved", movedPath, localPath), true);
    assert.equal(await store.recordLocalActivity("local-deleted", movedPath), true);
    const events = await store.listActivity();
    const localEvents = events.filter((event) => event.path === movedPath || event.path === localPath);
    assert.deepEqual(new Set(localEvents.map((event) => event.type)), new Set(["local-created", "local-edited", "local-read", "local-moved", "local-deleted"]));
    assert.equal(new Set(localEvents.map((event) => event.documentId)).size, 1);
    const insights = await store.getDashboardInsights();
    assert.equal(insights.documents.some((document) => document.document.path === movedPath), false);
    assert.ok(insights.summary.weekActivityScore >= 15);
  });
  await test("new document references contribute after their first observed baseline", async () => {
    const sourcePath = "研究/项目索引.md";
    const targetPath = "研究/项目复盘.md";
    await store.recordLocalActivity("local-created", sourcePath);
    await store.recordLocalActivity("local-created", targetPath);
    await store.recordDocumentReferences(sourcePath, []);
    await store.recordDocumentReferences(sourcePath, [targetPath]);
    const insights = await store.getDashboardInsights();
    const target = insights.documents.find((document) => document.document.path === targetPath);
    assert.equal(target?.connection, 4);
    assert.ok((await store.listActivity()).some((event) => event.type === "document-linked" && event.sourcePath === sourcePath && event.path === targetPath));
  });
  await test("contribution insights retain genuine activity recorded before startup", async () => {
    const historicVault = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-history-"));
    try {
      const dataDir = path.join(historicVault, "agentNote", "data");
      await fsp.mkdir(dataDir, { recursive: true });
      await fsp.writeFile(path.join(dataDir, "events.json"), JSON.stringify([{ at: "2025-01-01T00:00:00.000Z", type: "local-created", documentId: "d-old", path: "旧资料.md", title: "旧资料", origin: "local" }]), "utf8");
      await fsp.writeFile(path.join(dataDir, "documents.json"), JSON.stringify([{ id: "d-old", path: "旧资料.md", title: "旧资料", created: "2025-01-01T00:00:00.000Z", updated: "2025-01-01T00:00:00.000Z" }]), "utf8");
      const historicStore = new VaultStore(historicVault);
      await historicStore.init();
      const before = await historicStore.getDashboardInsights();
      assert.equal(before.summary.allTimeActivityScore, 4);
      assert.equal(before.documents.length, 1);
      assert.equal(before.timeline.length, 1);
      await historicStore.recordLocalActivity("local-created", "新资料.md");
      const after = await historicStore.getDashboardInsights();
      assert.equal(after.summary.allTimeActivityScore, 8);
      assert.equal(after.documents.length, 2);
    } finally {
      await fsp.rm(historicVault, { recursive: true, force: true });
    }
  });

  await test("installed agent prompt recognizes writing to Obsidian and correct share forms", async () => {
    const prompt = renderSkillMd({ port, instructions: "使用中文。", agentId: "codex", agentName: "Codex" });
    assert.match(prompt, /写到 Obsidian/); assert.match(prompt, /agent 笔记/); assert.match(prompt, /background/); assert.match(prompt, /tags/); assert.match(prompt, /第一层文件名称/); assert.match(prompt, /filePath/); assert.match(prompt, /link/); assert.match(prompt, /agentnote\.identity\.json/); assert.match(prompt, /X-AgentNote-Agent-Id: codex/); assert.match(prompt, /X-AgentNote-Agent-Name: Codex/); assert.match(prompt, /X-AgentNote-Session-Title/); assert.doesNotMatch(prompt, /scenarios/);
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-home-")); await fsp.mkdir(path.join(home, ".codex"));
    const codex = detectAgents(home).find((agent) => agent.id === "codex"); installSkill(codex.skillDir, { port, agentId: codex.id, agentName: codex.name }); assert.ok(fs.existsSync(path.join(codex.skillDir, "SKILL.md"))); assert.deepEqual(JSON.parse(await fsp.readFile(path.join(codex.skillDir, "agentnote.identity.json"), "utf8")), { version: 1, id: "codex", name: "Codex" }); await fsp.rm(home, { recursive: true, force: true });
  });
  await test("editable prompt templates retain dynamic service and identity values", async () => {
    const template = "为 {{agentName}} 配置 {{baseUrl}}，身份是 {{agentId}}。";
    const prompt = renderSkillMd({ port, template, agentId: "codex", agentName: "Codex" });
    assert.equal(prompt, `为 Codex 配置 http://127.0.0.1:${port}，身份是 codex。\n`);
    const manual = renderManualInstallPrompt({ port, template });
    assert.match(manual, new RegExp(`为 未命名 agent 配置 http://127\\.0\\.0\\.1:${port}，身份是 agentnote。`));
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
    assert.match(prompt, /不要假设/); assert.match(prompt, /GET http:\/\/127\.0\.0\.1/); assert.match(prompt, /自行验证/); assert.match(prompt, /agentnote\.identity\.json/); assert.match(prompt, /写到 Obsidian/); assert.match(prompt, /filePath/); assert.match(prompt, /PATCH .*\/api\/shares/);
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
