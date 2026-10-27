import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { VaultStore: CoreVaultStore, ActivityLog, isLocalActivityBurst, AgentServer, AgentConnections, agentNameKey, connectionsFile, splitSkillInstructions, withSkillInstructions, detectAgents, installSkill, skillInstallConflict, skillStatus, renderSkillMd, renderSharedSkillMd, renderManualInstallPrompt, isNewerVersion, languageFor, languageForPreference, setLanguage, locale, t } = require("./core-bundle.cjs");

const vault = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-e2e-"));
const identityRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-identities-"));
const defaultDeviceIdFile = path.join(identityRoot, "default-device-id");
class VaultStore extends CoreVaultStore {
  constructor(root, configDir = ".obsidian", options = {}) {
    super(root, configDir, { deviceIdFile: defaultDeviceIdFile, referencesFile: path.join(identityRoot, `references-${Buffer.from(root).toString('hex')}.json`), ...options });
  }
}
async function eventFiles(root) {
  const directory = path.join(root, "agentNote", "data", "events");
  const months = await fsp.readdir(directory).catch(() => []);
  return (await Promise.all(months.map(async (month) => (await fsp.readdir(path.join(directory, month))).map((name) => path.join(month, name))))).flat().sort();
}
const store = new VaultStore(vault);
const connections = new AgentConnections(connectionsFile(identityRoot));
let activityNotifications = 0;
const liveActivities = [];
const server = new AgentServer(store, { port: 0, onActivity: (activity) => { activityNotifications++; liveActivities.push(activity); }, listLinks: async (sourcePath) => sourcePath === "linked-source.md" ? [{ original: "[[linked-target|目标]]", link: "linked-target", displayText: "目标", targetPath: "linked-target.md", subpath: null, status: "resolved" }] : [], registerAgent: (name, skillPath, iconPath) => connections.register(name, skillPath, iconPath) });
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

  await test("a second vault waits for an occupied port and can start after release", async () => {
    const firstVault = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-port-owner-"));
    const secondVault = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-port-waiter-"));
    const firstServer = new AgentServer(new VaultStore(firstVault), { port: 0 });
    let secondServer;
    try {
      const occupiedPort = await firstServer.start();
      secondServer = new AgentServer(new VaultStore(secondVault), { port: occupiedPort });
      await assert.rejects(secondServer.start(), (error) => error.code === "EADDRINUSE");
      assert.equal(secondServer.port, null);
      const firstHealth = await (await fetch(`http://127.0.0.1:${occupiedPort}/api/health`)).json();
      assert.equal(firstHealth.data.vault, firstVault);
      await firstServer.stop();
      assert.equal(await secondServer.start(), occupiedPort);
      const secondHealth = await (await fetch(`http://127.0.0.1:${occupiedPort}/api/health`)).json();
      assert.equal(secondHealth.data.vault, secondVault);
    } finally {
      await firstServer.stop();
      if (secondServer) await secondServer.stop();
      await fsp.rm(firstVault, { recursive: true, force: true });
      await fsp.rm(secondVault, { recursive: true, force: true });
    }
  });

  let textId, textLink;
  await test("agent writes a normal note from a natural-language intent", async () => {
    const result = await api("POST", "/api/nodes", { title: "发布窗口", content: "周五晚间不发布生产版本。", background: "2026 年发布节奏约定，供部署任务参考。", source: "agent" }, { "x-agentnote-agent-name": "Codex", "x-agentnote-session-title": encodeURIComponent("发布流程验证") });
    assert.equal(result.status, 201); assert.equal(result.data.type, "snippet"); assert.equal(result.data.background.includes("发布节奏"), true); textId = result.data.id;
    assert.equal(result.data.status, "created");
    assert.equal(activityNotifications, 1);
    assert.equal(liveActivities.at(-1)?.operation, "created");
    assert.equal(liveActivities.at(-1)?.title, "发布窗口");
    assert.equal(liveActivities.at(-1)?.nodeId, result.data.id);
    assert.equal(liveActivities.at(-1)?.actor?.name, "Codex");
    assert.equal(liveActivities.at(-1)?.actor?.sessionTitle, "发布流程验证");
    assert.ok(result.data.link.startsWith(base)); assert.match(result.data.link, /\/api\/shares\/s-x-[0-9a-f]+\/resolve$/);
    textLink = result.data.link;
  });
  await test("legacy shares do not turn successful writes into failed responses", async () => {
    const sharesPath = path.join(vault, "agentNote", "data", "shares.json");
    const legacy = [{ id: "s-x-legacy", nodeId: textId, created: new Date().toISOString() }];
    const original = JSON.stringify(legacy);
    await fsp.writeFile(sharesPath, original);
    const result = await api("POST", "/api/nodes", { title: "兼容性验证", content: "旧分享记录存在时也应正常返回。" });
    assert.equal(result.status, 201); assert.equal(result.ok, true); assert.ok(result.data.id); assert.ok(result.data.created); assert.ok(result.data.updated);
    assert.equal(await fsp.readFile(sharesPath, "utf8"), original);
    assert.equal((await api("GET", "/api/shares/s-x-legacy/resolve")).status, 200);
  });
  await test("idempotency key creates exactly one note", async () => {
    const payload = { title: "幂等写入", content: "重复请求不能重复创建。", idempotencyKey: "create-note-001" };
    const notificationsBefore = activityNotifications;
    const first = await api("POST", "/api/nodes", payload);
    const second = await api("POST", "/api/nodes", payload);
    assert.equal(first.ok, true); assert.equal(second.ok, true); assert.equal(second.data.id, first.data.id);
    assert.equal(activityNotifications, notificationsBefore + 1);
    const concurrentPayload = { title: "并发幂等写入", content: "只创建一次。", idempotencyKey: "create-note-002" };
    const [parallelFirst, parallelSecond] = await Promise.all([api("POST", "/api/nodes", concurrentPayload), api("POST", "/api/nodes", concurrentPayload)]);
    assert.equal(parallelFirst.ok, true, JSON.stringify(parallelFirst));
    assert.equal(parallelSecond.ok, true, JSON.stringify(parallelSecond));
    assert.equal(parallelFirst.data.id, parallelSecond.data.id);
    assert.equal(activityNotifications, notificationsBefore + 2);
    const nodes = await api("GET", "/api/nodes?q=幂等写入");
    assert.equal(nodes.data.filter((node) => node.id === first.data.id).length, 1);
    assert.equal(nodes.data.filter((node) => node.id === parallelFirst.data.id).length, 1);
  });
  await test("the write response link is the note's permanent address", async () => {
    const result = await api("GET", textLink.replace(base, ""), undefined, { "x-agentnote-agent-name": "Codex", "x-agentnote-session-title": encodeURIComponent("发布流程验证") });
    assert.equal(result.data.kind, "text"); assert.equal(result.data.content, "周五晚间不发布生产版本。");
    assert.ok(path.isAbsolute(result.data.filePath)); assert.match(result.data.hint, /优先通过本链接/);
    assert.equal(liveActivities.at(-1)?.operation, "read");
    assert.equal(liveActivities.at(-1)?.title, "发布窗口");
    assert.equal(liveActivities.at(-1)?.shareId, textLink.split("/").at(-2));
  });
  await test("dashboard records successful link use and ranks reusable notes", async () => {
    const insights = await store.getDashboardInsights();
    assert.ok(insights.summary.weekResolves >= 1);
    assert.ok(insights.summary.weekUsedNotes >= 1);
    assert.equal(insights.weekly[0].node.id, textId);
    assert.match(insights.weekly[0].reason, /本周被读取/);
    assert.equal(insights.weeklyTrend.length, 7);
    assert.ok(insights.allTimeTrend.length >= 274 && insights.allTimeTrend.length <= 280);
    assert.ok(insights.startedAt);
    assert.ok(insights.timeline.length >= 2);
    assert.equal(insights.timeline.find((event) => event.type === "share-resolved")?.actor?.name, "Codex");
    assert.equal(insights.timeline.find((event) => event.type === "share-resolved")?.actor?.sessionTitle, "发布流程验证");
  });
  await test("dashboard counts each creation, update, share, and read once", async () => {
    const scoringVault = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-score-"));
    const scoringStore = new VaultStore(scoringVault);
    try {
      await scoringStore.init();
      const node = await scoringStore.createNode({ title: "统计样本", content: "用于验证知识活跃分。" });
      await scoringStore.updateNode(node.id, { content: "用于验证知识活跃分与维护行为。" });
      const share = await scoringStore.createShare(node.id);
      await scoringStore.resolveShare(share.id);
      const insights = await scoringStore.getDashboardInsights();
      assert.equal(insights.summary.weekActivityScore, 4);
      assert.equal(insights.summary.allTimeActivityScore, 4);
      assert.equal(insights.summary.weekActivityCount, 4);
      assert.equal(insights.summary.allTimeActivityCount, 4);
      const document = insights.documents.find((entry) => entry.document.title === "统计样本");
      assert.equal(document.activityCount, 4);
      assert.equal(document.recentActivityCount, 4);
      assert.equal(document.construction, 2);
      assert.equal(document.reuse, 2);
      assert.equal(document.construction + document.reuse + document.connection + document.organization, document.activityCount);
      assert.equal(insights.summary.weekCreated, 1);
      assert.equal(insights.summary.weekUpdated, 1);
      assert.equal(insights.summary.weekSharesCreated, 1);
      assert.equal(insights.summary.weekResolves, 1);
      assert.equal(insights.timeline.find((event) => event.type === "share-resolved")?.origin, "link");
      assert.ok(insights.timeline.some((event) => event.type === "share-created" && event.title === "统计样本"));
      assert.equal(insights.weeklyTrend.reduce((total, point) => total + point.count, 0), 4);
      const later = await scoringStore.getDashboardInsights(new Date("2027-01-02T12:00:00"));
      assert.equal(later.allTimeTrend.length, 280);
      assert.equal(later.allTimeTrend[0].label, "2026-03-29");
      assert.equal(later.allTimeTrend.at(-1).label, "2027-01-02");
      assert.equal(later.summary.allTimeActivityScore, 4);
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
    const future = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const before = await store.getDashboardInsights(future);
    assert.ok(before.archiveCandidates.some((candidate) => candidate.node.id === stale.id));
    const pinned = await store.updateNode(stale.id, { pinned: true });
    assert.equal(pinned.pinned, true);
    const after = await store.getDashboardInsights(future);
    assert.equal(after.archiveCandidates.some((candidate) => candidate.node.id === stale.id), false);
  });
  await test("archive suggestions follow first use and repeated use over time", async () => {
    const lifecycleVault = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-lifecycle-"));
    const lifecycleStore = new VaultStore(lifecycleVault);
    try {
      await lifecycleStore.init();
      const note = await lifecycleStore.createNode({ title: "长期参考", content: "可以反复复用。" });
      const share = await lifecycleStore.createShare(note.id);
      await lifecycleStore.resolveShare(share.id);
      const baseTime = Date.now();
      const candidatesAt = async (days) => (await lifecycleStore.getDashboardInsights(new Date(baseTime + days * 86_400_000))).archiveCandidates;
      assert.equal((await candidatesAt(8)).some((candidate) => candidate.node?.id === note.id), false);
      assert.equal((await candidatesAt(31)).some((candidate) => candidate.node?.id === note.id), true);
      const events = await lifecycleStore.listActivity();
      const use = events.find((event) => event.type === "share-resolved");
      await fsp.writeFile(path.join(lifecycleVault, "agentNote", "data", "events.injected.json"), JSON.stringify([{ ...use, eventId: "second-use", at: new Date(baseTime + 8 * 86_400_000).toISOString() }]));
      assert.equal((await candidatesAt(40)).some((candidate) => candidate.node?.id === note.id), false);
      assert.equal((await candidatesAt(99)).some((candidate) => candidate.node?.id === note.id), true);
    } finally {
      await fsp.rm(lifecycleVault, { recursive: true, force: true });
    }
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
    assert.equal(liveActivities.at(-1)?.targetKind, "folder");
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
  await test("linked target can be shared and read after a read-only link lookup", async () => {
    await fsp.writeFile(path.join(vault, "linked-source.md"), "见 [[linked-target|目标]]");
    await fsp.writeFile(path.join(vault, "linked-target.md"), "目标正文");
    const source = await api("POST", "/api/shares", { path: "linked-source.md" });
    assert.equal(source.status, 201);
    const before = (await store.listActivity()).length;
    const notifications = activityNotifications;
    const links = await api("GET", `/api/shares/${source.data.id}/links`);
    assert.equal(links.status, 200);
    assert.equal(links.data.sourcePath, "linked-source.md");
    assert.deepEqual(links.data.links, [{ original: "[[linked-target|目标]]", link: "linked-target", displayText: "目标", targetPath: "linked-target.md", subpath: null, status: "resolved" }]);
    assert.equal((await store.listActivity()).length, before);
    assert.equal(activityNotifications, notifications);
    const target = await api("POST", "/api/shares", { path: links.data.links[0].targetPath });
    assert.equal(target.status, 201);
    const resolved = await api("GET", `/api/shares/${target.data.id}/resolve`);
    assert.equal(resolved.status, 200);
    assert.equal(resolved.data.content, "目标正文");
    assert.ok((await store.listActivity()).some((event) => event.type === "share-resolved" && event.shareId === target.data.id));
  });
  await test("link lookup rejects shares without a whole Markdown source", async () => {
    assert.equal((await api("GET", "/api/shares/missing/links")).status, 404);
    await fsp.writeFile(path.join(vault, "other.txt"), "plain");
    const txt = await api("POST", "/api/shares", { path: "other.txt" });
    assert.equal((await api("GET", `/api/shares/${txt.data.id}/links`)).status, 400);
    const selection = await api("POST", "/api/shares", { path: "linked-source.md", selection: "见" });
    assert.equal((await api("GET", `/api/shares/${selection.data.id}/links`)).status, 400);
  });
  await test("legacy activity records recover their document title from the share", async () => {
    const created = await api("POST", "/api/shares", { path: "plain.md" });
    const eventsPath = path.join(vault, "agentNote", "data", "events.json");
    const events = [];
    events.push({ type: "share-resolved", shareId: created.data.id, targetKind: "file", at: new Date().toISOString() });
    await fsp.writeFile(eventsPath, JSON.stringify(events));
    assert.equal((await store.listActivity()).find((event) => event.shareId === created.data.id)?.title, "plain");
  });

  await test("archive is a folder move and does not break an existing share", async () => {
    const share = await api("POST", "/api/shares", { nodeId: textId });
    const documentPath = await store.nodeFilePath(textId);
    const documentBefore = (await store.getDashboardInsights()).documents.find((entry) => entry.document.path === documentPath);
    const archived = await api("POST", `/api/nodes/${textId}/archive`, { archived: true });
    assert.equal(archived.data.archived, true);
    assert.ok(fs.existsSync(path.join(vault, "agentNote", "nodes", "归档", "发布窗口.md")));
    const resolved = await api("GET", `/api/shares/${share.data.id}/resolve`); assert.equal(resolved.status, 200);
    const documentAfter = (await store.getDashboardInsights()).documents.find((entry) => entry.document.id === documentBefore?.document.id);
    assert.ok(documentAfter); assert.match(documentAfter.document.path, /归档/);
    assert.ok(documentAfter.score >= documentBefore.score);
    const restored = await api("POST", `/api/nodes/${textId}/archive`, { archived: false }); assert.equal(restored.data.archived, false);
  });
  await test("local archive protects user choice and keeps moved share links live", async () => {
    const localVault = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-local-archive-"));
    const localStore = new VaultStore(localVault);
    try {
      await localStore.init();
      await fsp.writeFile(path.join(localVault, "draft.md"), "# Draft", "utf8");
      await localStore.recordLocalActivity("local-created", "draft.md");
      await fsp.writeFile(path.join(localVault, "working.md"), "# Working", "utf8");
      await localStore.recordLocalActivity("local-created", "working.md");
      await localStore.recordLocalActivity("local-read", "working.md");
      const future = new Date(Date.now() + 8 * 86_400_000);
      const candidate = (await localStore.getDashboardInsights(future)).archiveCandidates.find((entry) => entry.document.path === "draft.md");
      assert.ok(candidate); assert.equal(candidate.node, undefined);
      assert.equal((await localStore.getDashboardInsights(future)).archiveCandidates.some((entry) => entry.document.path === "working.md"), false);
      assert.equal((await localStore.getDashboardInsights(new Date(Date.now() + 31 * 86_400_000))).archiveCandidates.some((entry) => entry.document.path === "working.md"), true);
      await localStore.protectDocument(candidate.document.id, true);
      assert.equal((await localStore.getDashboardInsights(future)).archiveCandidates.some((entry) => entry.document.id === candidate.document.id), false);
      await localStore.protectDocument(candidate.document.id, false);
      const share = await localStore.createPathShare("draft.md");
      await fsp.mkdir(path.join(localVault, "agentNote", "归档文件"), { recursive: true });
      await fsp.rename(path.join(localVault, "draft.md"), path.join(localVault, "agentNote", "归档文件", "draft.md"));
      await localStore.recordLocalActivity("local-moved", "agentNote/归档文件/draft.md", "draft.md");
      assert.equal((await localStore.resolveShare(share.id)).content, "# Draft");
      const after = await localStore.getDashboardInsights(future);
      assert.equal(after.archiveCandidates.some((entry) => entry.document.id === candidate.document.id), false);
      assert.ok(after.documents.some((entry) => entry.document.id === candidate.document.id && entry.document.path === "agentNote/归档文件/draft.md"));
    } finally {
      await fsp.rm(localVault, { recursive: true, force: true });
    }
  });

  await test("recent activity targets follow stable IDs through moves and never guess by title", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-activity-links-"));
    try {
      const isolated = new VaultStore(root);
      await isolated.init();
      await fsp.mkdir(path.join(root, "first"), { recursive: true });
      await fsp.mkdir(path.join(root, "second"), { recursive: true });
      await fsp.writeFile(path.join(root, "first", "同名.md"), "first");
      await fsp.writeFile(path.join(root, "second", "同名.md"), "second");
      await isolated.recordLocalActivity("local-created", "first/同名.md");
      await isolated.recordLocalActivity("local-created", "second/同名.md");
      const firstEvent = (await isolated.listActivity()).find((event) => event.path === "first/同名.md");
      const secondEvent = (await isolated.listActivity()).find((event) => event.path === "second/同名.md");
      assert.equal(await isolated.activityFilePath(firstEvent), "first/同名.md");
      assert.equal(await isolated.activityFilePath(secondEvent), "second/同名.md");
      const share = await isolated.createPathShare("second/同名.md");
      assert.equal(await isolated.activityFilePath({ shareId: share.id }), "second/同名.md");
      await fsp.rename(path.join(root, "second", "同名.md"), path.join(root, "second", "已整理.md"));
      await isolated.recordLocalActivity("local-moved", "second/已整理.md", "second/同名.md");
      assert.equal(await isolated.activityFilePath(secondEvent), "second/已整理.md");
      assert.equal(await isolated.activityFilePath({ shareId: share.id }), "second/已整理.md");
      const folder = await isolated.createPathShare("first");
      assert.equal(await isolated.activityFilePath({ shareId: folder.id }), null);
      await fsp.rm(path.join(root, "second", "已整理.md"));
      await isolated.recordLocalActivity("local-deleted", "second/已整理.md");
      assert.equal(await isolated.activityFilePath(secondEvent), null);
      assert.equal(await isolated.activityFilePath({ nodeId: "missing" }), null);
      assert.equal(await isolated.activityFilePath({}), null);
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  await test("custom Obsidian config folders stay out of activity and archive suggestions", async () => {
    const customVault = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-config-"));
    const previousStore = new VaultStore(customVault);
    try {
      await previousStore.init();
      await fsp.mkdir(path.join(customVault, ".my-obsidian"), { recursive: true });
      await fsp.writeFile(path.join(customVault, ".my-obsidian", "internal.md"), "# Internal", "utf8");
      await previousStore.recordLocalActivity("local-created", ".my-obsidian/internal.md");
      const customStore = new VaultStore(customVault, ".my-obsidian");
      assert.equal(await customStore.recordLocalActivity("local-read", ".my-obsidian/internal.md"), false);
      await fsp.writeFile(path.join(customVault, "visible.md"), "# Visible", "utf8");
      assert.equal(await customStore.recordLocalActivity("local-created", "visible.md"), true);
      const future = new Date(Date.now() + 8 * 86_400_000);
      const candidates = (await customStore.getDashboardInsights(future)).archiveCandidates;
      assert.equal(candidates.some((candidate) => candidate.document.path === ".my-obsidian/internal.md"), false);
      assert.equal(candidates.some((candidate) => candidate.document.path === "visible.md"), true);
    } finally {
      await fsp.rm(customVault, { recursive: true, force: true });
    }
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
    assert.ok(insights.summary.weekActivityCount >= 5);
  });
  await test("bulk detection uses a one-second window and ignored events preserve document state", async () => {
    const events = (types, times) => types.map((type, index) => ({ type, at: times[index] }));
    assert.equal(isLocalActivityBurst(events(["edit", "edit", "edit"], [0, 200, 400])), false);
    assert.equal(isLocalActivityBurst(events(["edit", "edit", "edit", "edit"], [0, 200, 400, 999])), true);
    assert.equal(isLocalActivityBurst(events(["edit", "edit", "edit", "edit"], [0, 400, 800, 1_200])), false);
    assert.equal(isLocalActivityBurst(events(Array.from({ length: 11 }, (_, index) => `type-${index}`), Array.from({ length: 11 }, (_, index) => index * 50))), true);
    assert.equal(isLocalActivityBurst(events(Array.from({ length: 11 }, (_, index) => `type-${index}`), Array.from({ length: 11 }, (_, index) => index * 100))), false);
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-bulk-"));
    try {
      const isolated = new VaultStore(root);
      await isolated.init();
      await fsp.writeFile(path.join(root, "draft.md"), "draft");
      const share = await isolated.createPathShare("draft.md");
      await isolated.recordLocalActivity("local-created", "draft.md", undefined, false);
      await fsp.rename(path.join(root, "draft.md"), path.join(root, "final.md"));
      await isolated.recordLocalActivity("local-moved", "final.md", "draft.md", false);
      assert.equal((await isolated.listActivity()).filter((event) => event.type.startsWith("local-")).length, 0);
      assert.equal((await isolated.listShares()).find((entry) => entry.id === share.id)?.target.path, "final.md");
      assert.equal(fs.existsSync(path.join(root, "agentNote", "data", "documents.json")), false);
      const document = (await isolated.getDashboardInsights()).archiveCandidates.find((entry) => entry.document.path === "final.md");
      assert.equal(document, undefined);
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
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
    assert.equal(target?.connection, 1);
    assert.equal(insights.weeklyDocuments.find((document) => document.document.path === targetPath)?.connection, 1);
    assert.ok(insights.weeklyDocuments.some((document) => document.document.path === sourcePath));
    const activity = await api("GET", `/api/insights/activity?documentId=${target.document.id}`);
    assert.equal(activity.status, 200);
    assert.ok(activity.data.some((event) => event.type === "document-linked" && event.documentId === target.document.id));
    assert.ok((await store.listActivity()).some((event) => event.type === "document-linked" && event.sourcePath === sourcePath && event.path === targetPath));
    const movedTarget = "研究/已整理/项目复盘.md";
    await store.recordLocalActivity("local-moved", movedTarget, targetPath);
    await store.recordDocumentReferences(sourcePath, [movedTarget]);
    assert.equal((await store.listActivity()).filter((event) => event.type === "document-linked" && event.documentId === target.document.id).length, 1);
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
      assert.equal(before.summary.allTimeActivityCount, 1);
      assert.equal(before.documents.length, 1);
      assert.equal(before.timeline.length, 1);
      assert.equal(before.activities[0]?.title, "旧资料", "recent activity includes records from before this week");
      await historicStore.recordLocalActivity("local-created", "新资料.md");
      const after = await historicStore.getDashboardInsights();
      assert.equal(after.summary.allTimeActivityCount, 2);
      assert.equal(after.documents.length, 2);
    } finally {
      await fsp.rm(historicVault, { recursive: true, force: true });
    }
  });

  await test("device logs merge across vault copies without rewriting another device's history", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-sync-"));
    try {
      const firstVault = path.join(root, "mac-vault");
      const secondVault = path.join(root, "windows-vault");
      const firstOptions = { deviceIdFile: path.join(root, "mac-local", "device-id") };
      const secondOptions = { deviceIdFile: path.join(root, "windows-local", "device-id") };
      const first = new VaultStore(firstVault, ".obsidian", firstOptions);
      await first.init();
      const note = await first.createNode({ title: "跨设备资料", content: "原文件仍由 Git 同步。" }, undefined, { actor: { id: "codex", name: "Codex" } });
      const share = await first.createShare(note.id);
      await first.resolveShare(share.id, { actor: { id: "codex", name: "Codex" } });
      const firstFiles = await eventFiles(firstVault);
      const firstBytes = await Promise.all(firstFiles.map((file) => fsp.readFile(path.join(firstVault, "agentNote", "data", "events", file))));
      await fsp.cp(firstVault, secondVault, { recursive: true });
      const second = new VaultStore(secondVault, ".obsidian", secondOptions);
      await second.init();
      assert.equal((await second.listActivity()).length, 3, "initializing a copied vault does not create events");
      await second.resolveShare(share.id, { actor: { id: "claude-code", name: "Claude Code" } });
      const secondFiles = await eventFiles(secondVault);
      const newFile = secondFiles.find((file) => !firstFiles.includes(file));
      assert.ok(newFile);
      const syncedSecondLog = path.join(firstVault, "agentNote", "data", "events", newFile);
      await fsp.copyFile(path.join(secondVault, "agentNote", "data", "events", newFile), syncedSecondLog);
      for (const current of [first, second]) {
        assert.equal((await current.listActivity()).length, 4);
        const insights = await current.getDashboardInsights();
        assert.equal(insights.summary.allTimeActivityScore, 4);
        assert.equal(insights.activities.filter((event) => event.type === "share-resolved").length, 2, "recent activity merges both devices");
        assert.equal(insights.documents.find((row) => row.document.title === "跨设备资料")?.activityCount, 4);
        assert.equal((await current.getDocumentInsights()).find((row) => row.nodeId === note.id)?.uses, 2);
        assert.deepEqual((await current.getAgentInsights()).map((row) => [row.name, row.uses]).sort(), [["Claude Code", 1], ["Codex", 1]]);
      }
      assert.deepEqual(await eventFiles(firstVault), secondFiles);
      assert.equal((await first.listActivity()).length, 4, "repeated sync does not count events twice");
      const foreignBytes = await fsp.readFile(syncedSecondLog);
      const restarted = new VaultStore(firstVault, ".obsidian", firstOptions);
      await restarted.init();
      await restarted.resolveShare(share.id);
      for (const [index, file] of firstFiles.entries()) assert.deepEqual(await fsp.readFile(path.join(firstVault, "agentNote", "data", "events", file)), firstBytes[index], "previous operations stay unchanged");
      assert.deepEqual(await fsp.readFile(syncedSecondLog), foreignBytes);
      assert.equal((await first.listActivity()).length, 5);
      assert.equal((await eventFiles(firstVault)).length, 5);
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  await test("legacy history stays read-only and event IDs deduplicate imported records", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-legacy-"));
    try {
      const data = path.join(root, "vault", "agentNote", "data");
      await fsp.mkdir(data, { recursive: true });
      const old = { at: "2025-01-01T00:00:00.000Z", type: "local-read", title: "旧资料", path: "旧资料.md" };
      const legacyPath = path.join(data, "events.json");
      const oldBytes = JSON.stringify([old, old]);
      await fsp.writeFile(legacyPath, oldBytes);
      const options = { deviceIdFile: path.join(root, "local", "device-id") };
      const log = new ActivityLog(data, options);
      await log.init();
      const historic = await log.read();
      assert.equal(historic.length, 2, "identical historic operations remain distinct");
      assert.notEqual(historic[0].eventId, historic[1].eventId);
      await fsp.writeFile(path.join(data, "events.imported.json"), JSON.stringify(historic));
      await log.append({ type: "local-read", title: "新资料" });
      assert.equal((await log.read()).length, 3);
      assert.equal(await fsp.readFile(legacyPath, "utf8"), oldBytes);
      assert.deepEqual((await new ActivityLog(data, options).read()).map((row) => row.eventId), (await log.read()).map((row) => row.eventId));
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  await test("cold backups keep past local and legacy days immutable without touching live logs", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-cold-backup-"));
    try {
      const data = path.join(root, "vault", "agentNote", "data");
      await fsp.mkdir(data, { recursive: true });
      const log = new ActivityLog(data, { deviceIdFile: path.join(root, "local", "device-id") });
      const localPath = await log.filePath();
      const deviceId = path.basename(localPath).slice("events.".length, -".json".length);
      const event = (day, title) => ({ at: new Date(2026, 8, day, 12).toISOString(), type: "local-read", title });
      const legacyPath = path.join(data, "events.json");
      const legacyBytes = JSON.stringify([event(27, "旧记录")]);
      const local = [event(27, "第一天"), event(28, "第二天"), event(29, "今天")];
      await fsp.writeFile(legacyPath, legacyBytes);
      await fsp.writeFile(localPath, JSON.stringify(local));
      const result = await log.backupPastDays(new Date(2026, 8, 29, 12));
      assert.deepEqual(result, { created: 3, existing: 0 });
      const backups = path.join(data, "cold-backups");
      const firstPath = path.join(backups, `events.${deviceId}.2026-09-27.json`);
      const secondPath = path.join(backups, `events.${deviceId}.2026-09-28.json`);
      const legacyBackup = path.join(backups, `events.legacy.${deviceId}.2026-09-27.json`);
      assert.deepEqual(JSON.parse(await fsp.readFile(firstPath, "utf8")), [local[0]]);
      assert.deepEqual(JSON.parse(await fsp.readFile(secondPath, "utf8")), [local[1]]);
      assert.deepEqual(JSON.parse(await fsp.readFile(legacyBackup, "utf8")), [event(27, "旧记录")]);
      assert.equal((await fsp.readdir(backups)).length, 3, "today has no backup yet");
      const before = await fsp.readFile(secondPath);
      local.push(event(28, "迟到的旧日期记录"));
      await fsp.writeFile(localPath, JSON.stringify(local));
      assert.deepEqual(await log.backupPastDays(new Date(2026, 8, 29, 12)), { created: 0, existing: 3 });
      assert.deepEqual(await fsp.readFile(secondPath), before, "existing snapshots are never overwritten");
      assert.equal(await fsp.readFile(legacyPath, "utf8"), legacyBytes);
      assert.deepEqual(JSON.parse(await fsp.readFile(localPath, "utf8")), local);
      await fsp.writeFile(localPath, "<<<<<<< conflict");
      assert.deepEqual(await log.backupPastDays(new Date(2026, 8, 29, 12)), { created: 0, existing: 1 });
      assert.deepEqual(await fsp.readFile(secondPath), before);
      assert.equal(await fsp.readFile(localPath, "utf8"), "<<<<<<< conflict");
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  await test("cold backups from two devices have separate names and retain their own events", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-cold-backup-devices-"));
    try {
      const data = path.join(root, "agentNote", "data");
      await fsp.mkdir(data, { recursive: true });
      await fsp.writeFile(path.join(data, "events.json"), JSON.stringify([{ at: new Date(2026, 8, 27, 12).toISOString(), type: "local-read", title: "旧版共享记录" }]));
      const logs = [];
      for (const [index, id] of ["machine-a", "machine-b"].entries()) {
        await fsp.writeFile(path.join(root, id), id);
        const log = new ActivityLog(data, { deviceIdFile: path.join(root, id) });
        logs.push(log);
        await fsp.writeFile(await log.filePath(), JSON.stringify([{ at: new Date(2026, 8, 27, 12).toISOString(), type: "local-read", title: `设备 ${index + 1}` }]));
      }
      for (const log of logs) assert.deepEqual(await log.backupPastDays(new Date(2026, 8, 29, 12)), { created: 2, existing: 0 });
      const backups = path.join(data, "cold-backups");
      assert.deepEqual((await fsp.readdir(backups)).sort(), ["events.legacy.machine-a.2026-09-27.json", "events.legacy.machine-b.2026-09-27.json", "events.machine-a.2026-09-27.json", "events.machine-b.2026-09-27.json"]);
      for (const [index, id] of ["machine-a", "machine-b"].entries()) {
        const events = JSON.parse(await fsp.readFile(path.join(backups, `events.${id}.2026-09-27.json`), "utf8"));
        assert.equal(events[0].title, `设备 ${index + 1}`);
      }
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  await test("concurrent writers on one device retain every operation and one identity", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-writers-"));
    try {
      const data = path.join(root, "vault", "agentNote", "data");
      await fsp.mkdir(data, { recursive: true });
      const options = { deviceIdFile: path.join(root, "local", "device-id") };
      const logs = [new ActivityLog(data, options), new ActivityLog(data, options)];
      await Promise.all(logs.map((log) => log.init()));
      assert.equal(await logs[0].filePath(), await logs[1].filePath());
      await Promise.all(Array.from({ length: 20 }, (_, i) => logs[i % 2].append({ type: "local-read", title: `操作 ${i}` })));
      const events = await logs[0].read();
      assert.equal(events.length, 20);
      assert.equal(new Set(events.map((event) => event.eventId)).size, 20);
      assert.equal(new Set(events.map((event) => event.deviceId)).size, 1);
      assert.equal((await fsp.readdir(data)).length, 1);
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  await test("damaged legacy history remains untouched while new activity continues", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-damaged-"));
    try {
      const data = path.join(root, "vault", "agentNote", "data");
      await fsp.mkdir(data, { recursive: true });
      const log = new ActivityLog(data, { deviceIdFile: path.join(root, "local", "device-id") });
      const file = await log.filePath();
      await fsp.writeFile(file, "broken JSON");
      await log.append({ type: "local-read" });
      assert.equal(await fsp.readFile(file, "utf8"), "broken JSON");
      assert.equal((await log.readReport()).issues.length, 1);
      assert.equal((await log.read()).length, 1);
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  await test("immutable events receive cold backups without rewriting the source", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-immutable-backup-"));
    try {
      const data = path.join(root, "agentNote", "data");
      const log = new ActivityLog(data, { deviceIdFile: path.join(root, "device-id") });
      await fsp.mkdir(data, { recursive: true });
      await log.append({ type: "local-read", title: "备份资料" });
      const event = (await log.read())[0];
      const source = path.join(data, "events", event.at.slice(0, 7), `${event.eventId}.json`);
      const before = await fsp.readFile(source);
      const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
      assert.deepEqual(await log.backupPastDays(tomorrow), { created: 1, existing: 0 });
      assert.deepEqual(await log.backupPastDays(tomorrow), { created: 0, existing: 1 });
      assert.deepEqual(await fsp.readFile(path.join(data, "cold-backups", "immutable", `${event.eventId}.json`)), before);
      assert.deepEqual(await fsp.readFile(source), before);
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });
  await test("legacy reference baselines stay untouched and first local observation creates no activity", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-reference-baseline-"));
    try {
      const data = path.join(root, "agentNote", "data");
      await fsp.mkdir(data, { recursive: true });
      const old = JSON.stringify({ "index.md": ["earlier.md"] });
      await fsp.writeFile(path.join(data, "references.json"), old);
      const isolated = new VaultStore(root, ".obsidian", { deviceIdFile: path.join(root, "local", "device-id"), referencesFile: path.join(root, "local", "references.json") });
      await isolated.init();
      await isolated.recordDocumentReferences("index.md", ["earlier.md", "new.md"]);
      assert.equal((await isolated.listActivity()).length, 0);
      assert.equal(await fsp.readFile(path.join(data, "references.json"), "utf8"), old);
      assert.deepEqual(JSON.parse(await fsp.readFile(path.join(root, "local", "references.json"), "utf8")), { "index.md": ["earlier.md", "new.md"] });
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });
  await test("damaged local reference state does not block a moved share", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-reference-failure-"));
    try {
      const referencesFile = path.join(root, "local", "references.json");
      const isolated = new VaultStore(root, ".obsidian", { deviceIdFile: path.join(root, "local", "device-id"), referencesFile });
      await isolated.init();
      await fsp.writeFile(path.join(root, "before.md"), "内容");
      const share = await isolated.createPathShare("before.md");
      await fsp.mkdir(path.dirname(referencesFile), { recursive: true });
      await fsp.writeFile(referencesFile, "<<<<<<< HEAD");
      await fsp.rename(path.join(root, "before.md"), path.join(root, "after.md"));
      await isolated.recordLocalActivity("local-moved", "after.md", "before.md");
      assert.equal((await isolated.resolveShare(share.id)).content, "内容");
      assert.equal((await isolated.listShares()).find((item) => item.id === share.id).target.path, "after.md");
      assert.equal((await isolated.getDashboardInsights()).health.complete, false);
      assert.equal(await fsp.readFile(referencesFile, "utf8"), "<<<<<<< HEAD");
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });
  await test("opposing protection choices pause archive suggestions until explicitly resolved", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-protection-conflict-"));
    try {
      const isolated = new VaultStore(root);
      await isolated.init();
      await isolated.recordLocalActivity("local-created", "conflicted.md");
      const documentId = (await isolated.listActivity())[0].documentId;
      await isolated.protectDocument(documentId, true);
      const eventId = "22222222-2222-4222-8222-222222222222";
      const at = new Date().toISOString();
      const month = at.slice(0, 7);
      const directory = path.join(root, "agentNote", "data", "events", month);
      await fsp.mkdir(directory, { recursive: true });
      await fsp.writeFile(path.join(directory, `${eventId}.json`), JSON.stringify({ at, eventId, deviceId: "another-device", type: "document-protection", documentId, path: "conflicted.md", protected: false, stateOnly: true, storageVersion: 2 }));
      const uncertain = await isolated.getDashboardInsights();
      assert.equal(uncertain.health.complete, false);
      assert.equal(uncertain.protectedDocuments.some((document) => document.id === documentId), true);
      assert.deepEqual(uncertain.archiveCandidates, []);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await isolated.protectDocument(documentId, false);
      const settled = await isolated.getDashboardInsights();
      assert.equal(settled.health.complete, true);
      assert.equal(settled.protectedDocuments.some((document) => document.id === documentId), false);
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  await test("node archive keeps one document identity across a restart", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-archive-identity-"));
    try {
      const isolated = new VaultStore(root);
      await isolated.init();
      const node = await isolated.createNode({ title: "可归档资料" });
      const created = (await isolated.listActivity()).find((event) => event.type === "node-created" && event.nodeId === node.id);
      await isolated.archiveNode(node.id, true);
      const archived = (await isolated.listActivity()).find((event) => event.type === "node-archived" && event.nodeId === node.id);
      assert.equal(archived.documentId, created.documentId);
      const restarted = new VaultStore(root);
      await restarted.init();
      const document = (await restarted.getDashboardInsights()).documents.find((entry) => entry.document.id === created.documentId);
      assert.equal(document?.document.path.includes("归档"), true);
      assert.equal(document?.activityCount, 2);
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  await test("damaged independent events and duplicate IDs show partial history without guessing", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-partial-history-"));
    try {
      const data = path.join(root, "agentNote", "data");
      const log = new ActivityLog(data, { deviceIdFile: path.join(root, "local", "device-id") });
      await fsp.mkdir(data, { recursive: true });
      await log.append({ type: "local-read", title: "可用记录" });
      const month = new Date().toISOString().slice(0, 7);
      const damaged = path.join(data, "events", month, "11111111-1111-4111-8111-111111111111.json");
      await fsp.writeFile(damaged, "<<<<<<< HEAD");
      const duplicate = { eventId: "duplicate", at: new Date().toISOString(), type: "local-read", title: "甲" };
      await fsp.writeFile(path.join(data, "events.legacy-a.json"), JSON.stringify([duplicate]));
      await fsp.writeFile(path.join(data, "events.legacy-b.json"), JSON.stringify([{ ...duplicate, title: "乙" }]));
      const report = await log.readReport();
      assert.deepEqual(report.events.map((event) => event.title), ["可用记录"]);
      assert.equal(report.issues.length, 2);
      assert.equal(await fsp.readFile(damaged, "utf8"), "<<<<<<< HEAD");
      await fsp.writeFile(damaged, JSON.stringify({ eventId: "11111111-1111-4111-8111-111111111111", at: new Date().toISOString(), type: "local-read", title: "已恢复记录" }));
      await fsp.rm(path.join(data, "events.legacy-a.json"));
      await fsp.rm(path.join(data, "events.legacy-b.json"));
      const recovered = await log.readReport();
      assert.equal(recovered.issues.length, 0);
      assert.deepEqual(new Set(recovered.events.map((event) => event.title)), new Set(["可用记录", "已恢复记录"]));
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  await test("activity storage failure never blocks sharing and is visible in dashboard health", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-history-write-failure-"));
    try {
      const isolated = new VaultStore(root);
      await isolated.init();
      await fsp.rm(path.join(root, "agentNote", "data", "events"), { recursive: true, force: true });
      await fsp.writeFile(path.join(root, "agentNote", "data", "events"), "not a directory");
      const node = await isolated.createNode({ title: "仍可分享", content: "原文保留" });
      const share = await isolated.createShare(node.id);
      assert.equal((await isolated.resolveShare(share.id)).content, "原文保留");
      const dashboard = await isolated.getDashboardInsights();
      assert.equal(dashboard.health.complete, false);
      assert.ok(dashboard.health.issues.some((issue) => issue.includes("events")));
      assert.equal(await fsp.readFile(path.join(root, "agentNote", "data", "events"), "utf8"), "not a directory");
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  await test("damaged optional indexes preserve sharing and activity while keyed writes fail safely", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-shared-damaged-"));
    try {
      const isolated = new VaultStore(root);
      await isolated.init();
      const node = await isolated.createNode({ title: "保留的笔记" });
      const data = path.join(root, "agentNote", "data");
      for (const [name, operation] of [
        ["agents.json", () => isolated.registerAgent({ id: "codex", name: "Codex" })],
        ["idempotency.json", () => isolated.createNode({ title: "不应创建" }, "key-1")],
      ]) {
        const file = path.join(data, name);
        const original = await fsp.readFile(file, "utf8").catch(() => null);
        await fsp.writeFile(file, "<<<<<<< HEAD\n[]\n=======\n{}\n>>>>>>> branch\n");
        if (name === "agents.json") await operation();
        else await assert.rejects(operation(), (error) => error.statusCode === 409 && error.message.includes(name));
        assert.match(await fsp.readFile(file, "utf8"), /^<<<<<<< HEAD/);
        if (original === null) await fsp.rm(file); else await fsp.writeFile(file, original);
      }
      assert.equal((await isolated.listNodes()).some((entry) => entry.title === "不应创建"), false);
      await isolated.registerAgent({ id: "codex", name: "Codex" });
      await isolated.createShare(node.id);
      assert.equal((await isolated.listShares()).length, 1);
      const documents = path.join(data, "documents.json");
      await fsp.writeFile(documents, '[{"id":"partial"}]');
      await isolated.recordLocalActivity("local-edited", "note.md");
      assert.equal((await isolated.getDashboardInsights()).health.documentsAvailable, false);
      assert.equal(await fsp.readFile(documents, "utf8"), '[{"id":"partial"}]');
      await fsp.writeFile(path.join(root, "note.md"), "before");
      const fileShare = await isolated.createPathShare("note.md");
      assert.equal((await isolated.resolveShare(fileShare.id)).content, "before");
      assert.equal((await isolated.updateShareContent(fileShare.id, "after")).content, "after");
      assert.equal(await fsp.readFile(documents, "utf8"), '[{"id":"partial"}]');
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  await test("new shares survive damaged legacy registry and preserve its bytes", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-share-recovery-"));
    try {
      const isolated = new VaultStore(root);
      await isolated.init();
      const node = await isolated.createNode({ title: "恢复分享", content: "初始正文" });
      const data = path.join(root, "agentNote", "data");
      const legacyPath = path.join(data, "shares.json");
      assert.equal(fs.existsSync(legacyPath), false);
      const legacy = JSON.stringify([{ id: "s-x-legacy", nodeId: node.id, created: new Date().toISOString() }]);
      await fsp.writeFile(legacyPath, legacy);
      assert.equal((await isolated.resolveShare("s-x-legacy")).content, "初始正文");
      const damaged = "<<<<<<< HEAD\n[]\n=======\n{}\n>>>>>>> branch\n";
      await fsp.writeFile(legacyPath, damaged);
      const created = await isolated.createShare(node.id);
      const sharePath = path.join(data, "shares", `${created.id}.json`);
      assert.equal(JSON.parse(await fsp.readFile(sharePath, "utf8")).id, created.id);
      assert.equal((await isolated.resolveShare(created.id)).content, "初始正文");
      assert.equal((await isolated.updateShareContent(created.id, "更新后的正文")).content, "更新后的正文");
      assert.equal((await isolated.listShares()).some((share) => share.id === created.id), true);
      await assert.rejects(isolated.resolveShare("s-x-legacy"), (error) => error.statusCode === 409 && error.message.includes("shares.json"));
      assert.equal(await fsp.readFile(legacyPath, "utf8"), damaged);
      await fsp.writeFile(legacyPath, legacy);
      assert.equal((await isolated.resolveShare("s-x-legacy")).content, "更新后的正文");
      assert.equal(await fsp.readFile(legacyPath, "utf8"), legacy);
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  await test("selection metadata describes current range and never adds unshared surrounding text", async () => {
    const text = "# 标题\n背景😀\n只分享这段\n未分享的结尾";
    await fsp.writeFile(path.join(vault, "excerpt.md"), text);
    const share = await api("POST", "/api/shares", { path: "excerpt.md", selection: "只分享这段", selectionStart: text.indexOf("只分享") });
    const url = `/api/shares/${share.data.id}/resolve`;
    const result = (await api("GET", url)).data;
    assert.equal(result.content, "只分享这段");
    assert.equal(result.selection.scope, "selection");
    assert.equal(result.selection.isCompleteDocument, false);
    assert.equal(result.selection.sourceLength, text.length);
    assert.equal(result.selection.selectedLength, 5);
    assert.equal(result.selection.coverage, 5 / text.length);
    assert.deepEqual(result.selection.position, { status: "exact", startOffset: text.indexOf("只分享"), endOffset: text.indexOf("只分享") + 5, startLine: 3, endLine: 3 });
    const raw = await (await fetch(base + url + "?raw=1")).text();
    assert.match(raw, /agentNote selection/);
    assert.match(raw, /只分享这段/);
    assert.doesNotMatch(raw, /未分享的结尾|背景😀/);
    await fsp.writeFile(path.join(vault, "excerpt.md"), "前面新增一行\n" + text);
    assert.equal((await api("GET", url)).data.selection.position.startLine, 4);
    await fsp.writeFile(path.join(vault, "excerpt.md"), "选段已删除");
    assert.equal((await api("GET", url)).status, 410);
  });
  await test("repeated selections use the chosen occurrence and refuse ambiguous writes", async () => {
    const text = "重复\n中间\n重复";
    await fsp.writeFile(path.join(vault, "repeated.md"), text);
    const share = await api("POST", "/api/shares", { path: "repeated.md", selection: "重复", selectionStart: text.lastIndexOf("重复") });
    const url = `/api/shares/${share.data.id}`;
    assert.equal((await api("GET", url + "/resolve")).data.selection.position.startLine, 3);
    // The original saved offset still contains the same text after this edit,
    // but no longer identifies the original occurrence. Never trust it blindly.
    await fsp.writeFile(path.join(vault, "repeated.md"), text + "\n重复");
    assert.equal((await api("GET", url + "/resolve")).data.selection.position.status, "ambiguous");
    await fsp.writeFile(path.join(vault, "repeated.md"), text);
    await api("PATCH", url, { content: "第二处" });
    assert.equal(await fsp.readFile(path.join(vault, "repeated.md"), "utf8"), "重复\n中间\n第二处");
    const ambiguous = await api("POST", "/api/shares", { path: "repeated.md", selection: "重复" });
    await fsp.writeFile(path.join(vault, "repeated.md"), "重复\n重复");
    assert.equal((await api("GET", `/api/shares/${ambiguous.data.id}/resolve`)).data.selection.position.status, "ambiguous");
    assert.equal((await api("PATCH", `/api/shares/${ambiguous.data.id}`, { content: "不能误改" })).status, 409);
    assert.equal(await fsp.readFile(path.join(vault, "repeated.md"), "utf8"), "重复\n重复");
  });
  await test("node selections describe body offsets and whole-note responses stay unchanged", async () => {
    const { data: node } = await api("POST", "/api/nodes", { title: "节选元数据", content: "开头\n正文\n结尾" });
    const share = await api("POST", "/api/shares", { nodeId: node.id, selection: "正文" });
    const selected = (await api("GET", `/api/shares/${share.data.id}/resolve`)).data;
    assert.equal(selected.selection.position.startLine, 2);
    assert.equal(selected.selection.sourceLength, node.content.length);
    const whole = await api("GET", new URL(node.link).pathname);
    assert.equal(whole.data.selection, undefined);
    assert.equal(await (await fetch(node.link + "?raw=1")).text(), node.content);
    await api("PATCH", `/api/shares/${share.data.id}`, { content: "" });
    const removed = (await api("GET", `/api/shares/${share.data.id}/resolve`)).data;
    assert.equal(removed.content, "");
    assert.equal(removed.selection.selectedLength, 0);
    assert.equal(removed.selection.isCompleteDocument, false);
    const all = await api("POST", "/api/shares", { nodeId: node.id, selection: (await store.getNode(node.id)).content });
    const allResult = (await api("GET", `/api/shares/${all.data.id}/resolve`)).data;
    assert.equal(allResult.selection.isCompleteDocument, true);
    assert.equal(allResult.selection.coverage, 1);
  });
  await test("editing a legacy selection creates an independent record without rewriting history", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-legacy-share-edit-"));
    try {
      const isolated = new VaultStore(root);
      await isolated.init();
      const node = await isolated.createNode({ title: "旧选段", content: "alpha beta" });
      const legacyPath = path.join(root, "agentNote", "data", "shares.json");
      const original = JSON.stringify([{ id: "s-x-legacy-selection", nodeId: node.id, selection: "beta", created: new Date().toISOString() }]);
      await fsp.writeFile(legacyPath, original);
      assert.equal((await isolated.updateShareContent("s-x-legacy-selection", "gamma")).content, "gamma");
      assert.equal((await isolated.resolveShare("s-x-legacy-selection")).content, "gamma");
      assert.equal((await isolated.getNode(node.id)).content, "alpha gamma");
      assert.equal(await fsp.readFile(legacyPath, "utf8"), original);
      const overlay = JSON.parse(await fsp.readFile(path.join(root, "agentNote", "data", "shares", "s-x-legacy-selection.json"), "utf8"));
      assert.equal(overlay.selection, "gamma");
      assert.equal((await isolated.listShares()).filter((share) => share.id === overlay.id).length, 1);
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  await test("a damaged share file does not block healthy links or overwrite either file", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-share-isolation-"));
    try {
      const isolated = new VaultStore(root);
      await isolated.init();
      const node = await isolated.createNode({ title: "隔离分享", content: "内容" });
      const broken = await isolated.createShare(node.id);
      const healthy = await isolated.createShare(node.id);
      const brokenPath = path.join(root, "agentNote", "data", "shares", `${broken.id}.json`);
      const damaged = "invalid share JSON";
      await fsp.writeFile(brokenPath, damaged);
      assert.equal((await isolated.resolveShare(healthy.id)).content, "内容");
      assert.equal((await isolated.listShares()).some((share) => share.id === healthy.id), true);
      await assert.rejects(isolated.resolveShare(broken.id), (error) => error.statusCode === 409 && error.message.includes(broken.id));
      assert.equal(await fsp.readFile(brokenPath, "utf8"), damaged);
      await assert.rejects(isolated.resolveShare("s-x-../documents"), (error) => error.statusCode === 404);
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  });

  await test("installed agent prompt recognizes writing to Obsidian and correct share forms", async () => {
    const prompt = renderSkillMd({ port, instructions: "使用中文。", agentId: "codex", agentName: "Codex" });
    assert.match(prompt, /description: .*27182 端口的地址时，使用它读取，不要用网页抓取工具直接访问。/);
    assert.match(prompt, /写到 Obsidian/); assert.match(prompt, /agent 笔记/); assert.match(prompt, /background/); assert.match(prompt, /tags/); assert.match(prompt, /第一层文件名称/); assert.match(prompt, /filePath/); assert.match(prompt, /link/); assert.match(prompt, /agentnote\.identity\.json/); assert.match(prompt, /X-AgentNote-Agent-Id: codex/); assert.match(prompt, /X-AgentNote-Agent-Name: Codex/); assert.match(prompt, /X-AgentNote-Session-Title/); assert.doesNotMatch(prompt, /scenarios/);
    assert.match(prompt, /类型 ｜ 文档标题/); assert.match(prompt, /Obsidian Markdown/); assert.match(prompt, /多个分享地址/);
    assert.match(prompt, /GET  http:\/\/127\.0\.0\.1:\d+\/api\/shares\/<id>\/links/);
    assert.match(prompt, /按需读取分享笔记中的双链目标/);
    assert.match(prompt, /提取括号内地址，同样直接 GET/);
    assert.match(prompt, /向用户返回分享地址时，用/);
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-home-")); await fsp.mkdir(path.join(home, ".codex"));
    const codex = detectAgents(home).find((agent) => agent.id === "codex"); installSkill(codex.skillDir, { port, agentId: codex.id, agentName: codex.name }); assert.ok(fs.existsSync(path.join(codex.skillDir, "SKILL.md"))); const identity = JSON.parse(await fsp.readFile(path.join(codex.skillDir, "agentnote.identity.json"), "utf8")); assert.equal(identity.id, "codex"); assert.equal(identity.name, "Codex"); assert.match(identity.skillHash, /^[a-f0-9]{64}$/); assert.match(identity.defaultTemplateHash, /^[a-f0-9]{64}$/); await fsp.rm(home, { recursive: true, force: true });
  });
  await test("skill status distinguishes default updates from custom and legacy prompts", async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-skill-status-"));
    const dir = path.join(home, "agentnote");
    try {
      const options = { port, agentId: "codex", agentName: "Codex" };
      installSkill(dir, options);
      assert.equal(skillStatus(dir, options), "current");
      const identityPath = path.join(dir, "agentnote.identity.json");
      const identity = JSON.parse(await fsp.readFile(identityPath, "utf8"));
      await fsp.writeFile(identityPath, JSON.stringify({ ...identity, defaultTemplateHash: "older" }));
      assert.equal(skillStatus(dir, options), "update");
      assert.equal(skillStatus(dir, { ...options, template: "用户自定义模板" }), "custom");
      await fsp.appendFile(path.join(dir, "SKILL.md"), "\n用户手动添加的内容");
      assert.equal(skillStatus(dir, options), "custom");
      await fsp.writeFile(identityPath, JSON.stringify({ version: 1, id: "codex", name: "Codex" }));
      assert.equal(skillStatus(dir, options), "unknown");
      await fsp.writeFile(path.join(dir, "SKILL.md"), renderSkillMd(options));
      assert.equal(skillStatus(dir, options), "current");
    } finally { await fsp.rm(home, { recursive: true, force: true }); }
  });
  await test("skill updates preserve hand-edited files until explicitly backed up", async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-skill-backup-"));
    const dir = path.join(home, "agentnote");
    const options = { port, agentId: "codex", agentName: "Codex" };
    try {
      installSkill(dir, options);
      assert.equal(skillInstallConflict(dir, "codex"), false);
      const skillFile = path.join(dir, "SKILL.md");
      await fsp.appendFile(skillFile, "\nUser's own instruction.\n");
      const edited = await fsp.readFile(skillFile, "utf8");
      assert.equal(skillInstallConflict(dir, "codex"), true);
      assert.throws(() => installSkill(dir, options), /已停止覆盖/);
      assert.equal(await fsp.readFile(skillFile, "utf8"), edited);
      installSkill(dir, options, true);
      const backup = (await fsp.readdir(dir)).find((name) => name.startsWith("SKILL.md.agentnote-backup-"));
      assert.ok(backup);
      assert.equal(await fsp.readFile(path.join(dir, backup), "utf8"), edited);
      assert.equal(skillInstallConflict(dir, "codex"), false);
      assert.equal(skillInstallConflict(dir, "claude-code"), true);
    } finally { await fsp.rm(home, { recursive: true, force: true }); }
  });
  await test("downloadable skill is stable and independent of the target Agent", async () => {
    const template = "为 {{agentName}} 配置 {{baseUrl}}，身份是 {{agentId}}。";
    const prompt = renderSkillMd({ port, template, agentId: "codex", agentName: "Codex" });
    assert.equal(prompt, `为 Codex 配置 http://127.0.0.1:${port}，身份是 codex。\n`);
    const response = await fetch(`${base}/api/skill.md`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(await response.text(), renderSharedSkillMd(port));
    assert.match(renderSharedSkillMd(port), /X-AgentNote-Agent-Id: <读取 agentnote\.identity\.json/);
  });
  await test("optional Skill icon serves the existing product SVG", async () => {
    const response = await fetch(`${base}/api/skill-icon.svg`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/svg+xml; charset=utf-8");
    assert.equal(await response.text(), await fsp.readFile("assets/brand/xiaoji-mark.svg", "utf8"));
  });
  await test("ICO Skill icon serves every required size without conversion", async () => {
    const response = await fetch(`${base}/api/skill-icon.ico`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/x-icon");
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, await fsp.readFile("assets/brand/skill-icon.ico"));
    assert.equal(bytes.readUInt16LE(0), 0);
    assert.equal(bytes.readUInt16LE(2), 1);
    assert.equal(bytes.readUInt16LE(4), 7);
    const sizes = Array.from({ length: 7 }, (_, i) => bytes[6 + i * 16] || 256);
    assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
  });
  await test("PNG Skill icon has the exact bundled pixels and a transparent 256px canvas", async () => {
    const response = await fetch(`${base}/api/skill-icon.png`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, await fsp.readFile("assets/brand/skill-icon.png"));
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    assert.equal(bytes.readUInt32BE(16), 256);
    assert.equal(bytes.readUInt32BE(20), 256);
    assert.equal(bytes[25], 6); // RGBA, including transparency.
    assert.match(renderManualInstallPrompt({ port }), /interface.icon_small 和 interface.icon_large.*assets\/icon.ico/);
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
  await test("installation prompt gives one shared skill, identity setup, and first report", async () => {
    const prompt = renderManualInstallPrompt({ port });
    assert.match(prompt, /\/api\/skill\.md/); assert.match(prompt, /SKILL\.md/); assert.match(prompt, /agentnote\.identity\.json/); assert.match(prompt, /\/api\/agents\/register/); assert.match(prompt, /skillPath/); assert.match(prompt, /最后简单确认/);
    assert.match(prompt, /iconPath 是上报当前 Agent 自身 ico，不是 agentNote 的图标/);
    assert.match(prompt, /优先从当前 Agent 的官方网站获取其官方 PNG、ICO 或 SVG 图标/);
    assert.match(prompt, /\/api\/skill-icon\.ico.*不要作为 iconPath 上报/);
    assert.doesNotMatch(prompt, /\/api\/health/);
  });
  await test("first Agent report stores a local path and matches names case-insensitively", async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-onboarding-"));
    const skillDir = path.join(directory, "agentnote");
    await fsp.mkdir(skillDir);
    const skillPath = path.join(skillDir, "SKILL.md");
    try {
      await fsp.writeFile(skillPath, renderSharedSkillMd(port));
      await fsp.writeFile(path.join(skillDir, "agentnote.identity.json"), JSON.stringify({ id: "codex", name: "Codex" }));
      assert.equal(agentNameKey("CODEX"), agentNameKey("Codex"));
      const connected = await api("POST", "/api/agents/register", { name: "CODEX", skillPath });
      assert.equal(connected.status, 200);
      assert.equal(connected.data.skillPath, await fsp.realpath(skillPath));
      assert.equal((await connections.list()).length, 1);
      const productIconPath = path.join(skillDir, "product.svg");
      await fsp.copyFile("assets/brand/xiaoji-mark.svg", productIconPath);
      const productIconReport = await api("POST", "/api/agents/register", { name: "Codex", skillPath, iconPath: productIconPath });
      assert.equal(productIconReport.status, 200);
      assert.equal(productIconReport.data.icon, undefined);
      const iconPath = path.join(skillDir, "agent.svg");
      await fsp.writeFile(iconPath, '<svg xmlns="http://www.w3.org/2000/svg"/>');
      const withIcon = await api("POST", "/api/agents/register", { name: "Codex", skillPath, iconPath });
      assert.equal(withIcon.status, 200);
      assert.match(withIcon.data.icon, /^data:image\/svg\+xml;base64,/);
      assert.equal((await connections.list())[0].icon, withIcon.data.icon);
      const legacyFile = path.join(directory, "legacy-connections.json");
      const productIconData = `data:image/svg+xml;base64,${(await fsp.readFile(productIconPath)).toString("base64")}`;
      const legacyContent = JSON.stringify([{ name: "Example", skillPath, connectedAt: new Date().toISOString(), icon: productIconData }]);
      await fsp.writeFile(legacyFile, legacyContent);
      assert.equal((await new AgentConnections(legacyFile).list())[0].icon, undefined);
      assert.equal(await fsp.readFile(legacyFile, "utf8"), legacyContent);
      assert.equal((await api("POST", "/api/agents/register", { name: "Codex", skillPath })).status, 200);
      assert.equal((await connections.list()).length, 1);
      assert.equal((await connections.list())[0].icon, withIcon.data.icon);
      assert.equal((await api("POST", "/api/agents/register", { name: "Codex", skillPath, iconPath: 123 })).status, 400);
      assert.equal((await api("POST", "/api/agents/register", { name: "Codex", skillPath, iconPath: skillPath })).status, 400);
      const outsideIcon = path.join(directory, "outside.svg");
      await fsp.writeFile(outsideIcon, '<svg/>');
      assert.equal((await api("POST", "/api/agents/register", { name: "Codex", skillPath, iconPath: outsideIcon })).status, 400);
      const largeIcon = path.join(skillDir, "large.png");
      await fsp.writeFile(largeIcon, Buffer.alloc(128_001));
      assert.equal((await api("POST", "/api/agents/register", { name: "Codex", skillPath, iconPath: largeIcon })).status, 400);
      const invalid = await api("POST", "/api/agents/register", { name: "Claude Code", skillPath });
      assert.equal(invalid.status, 400);
      const original = await connections.readSkill((await connections.list())[0]);
      await connections.saveSkill((await connections.list())[0], original, `${original}\n补充要求。\n`);
      assert.match(await fsp.readFile(skillPath, "utf8"), /补充要求/);
      assert.ok((await fsp.readdir(skillDir)).some((name) => name.startsWith("SKILL.md.agentnote-backup-")));
      await assert.rejects(connections.saveSkill((await connections.list())[0], original, original), /其他程序修改/);
      await connections.remove("CODEX");
      assert.equal((await connections.list()).length, 0);
      assert.equal(fs.existsSync(skillPath), false);
      assert.ok((await fsp.readdir(skillDir)).filter((name) => name.startsWith("SKILL.md.agentnote-backup-")).length >= 2);
    } finally { await fsp.rm(directory, { recursive: true, force: true }); }
  });
  await test("Agent connections live in one machine-wide file and migrate the old per-vault files", async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-connections-"));
    const state = path.join(home, ".agentnote");
    const skills = path.join(home, "skills");
    await fsp.mkdir(state); await fsp.mkdir(skills);
    const skillPath = path.join(skills, "SKILL.md");
    await fsp.writeFile(skillPath, renderSharedSkillMd(port));
    await fsp.writeFile(path.join(skills, "agentnote.identity.json"), JSON.stringify({ id: "codex", name: "Codex" }));
    const file = connectionsFile(home);
    const record = (name, path, at) => ({ name, skillPath: path, connectedAt: at });
    const vaultA = path.join(state, "connections.aaaaaaaaaaaaaaaa.json");
    const vaultB = path.join(state, "connections.bbbbbbbbbbbbbbbb.json");
    try {
      assert.equal(file, path.join(state, "connections.json"));
      await fsp.writeFile(vaultA, JSON.stringify([record("Codex", skillPath, "2026-10-19T09:46:33.995Z"), record("Stale", path.join(home, "gone", "SKILL.md"), "2026-10-01T00:00:00Z")]));
      await fsp.writeFile(vaultB, JSON.stringify([record("CODEX", skillPath, "2026-10-21T00:00:00Z")]));
      const migration = new AgentConnections(file);
      const migrated = await migration.list();
      assert.deepEqual(migrated.map((item) => [item.name, item.connectedAt]), [["CODEX", "2026-10-21T00:00:00Z"]]);
      assert.deepEqual(JSON.parse(await fsp.readFile(file, "utf8")).map((item) => item.name), ["CODEX"]);
      assert.equal(JSON.parse(await fsp.readFile(vaultA, "utf8")).length, 2, "legacy files stay untouched");
      await migration.register("Codex", skillPath);
      const after = await migration.list();
      assert.equal(after.length, 1);
      assert.ok(after[0].connectedAt > "2026-10-21T00:00:00Z");
      assert.deepEqual((await fsp.readdir(state)).sort(), ["connections.aaaaaaaaaaaaaaaa.json", "connections.bbbbbbbbbbbbbbbb.json", "connections.json"]);
      const fresh = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-connections-fresh-"));
      try {
        assert.deepEqual(await new AgentConnections(connectionsFile(fresh)).list(), []);
        assert.equal(fs.existsSync(path.join(fresh, ".agentnote", "connections.json")), false);
      } finally { await fsp.rm(fresh, { recursive: true, force: true }); }
    } finally { await fsp.rm(home, { recursive: true, force: true }); }
  });
  await test("additional instructions update the preview without duplicating earlier additions", async () => {
    const baseSkill = renderSharedSkillMd(port);
    const first = withSkillInstructions(baseSkill, "使用中文回复。");
    assert.equal(splitSkillInstructions(first).additional, "使用中文回复。");
    const next = withSkillInstructions(splitSkillInstructions(first).base, "先核对来源，再写入笔记。");
    assert.equal(splitSkillInstructions(next).additional, "先核对来源，再写入笔记。");
    assert.equal(next.match(/## 附加要求/g)?.length, 1);
    assert.doesNotMatch(next, /使用中文回复/);
    assert.equal(withSkillInstructions(splitSkillInstructions(next).base, ""), baseSkill);
  });

  await test("language selection follows the host and preserves interpolation values", async () => {
    for (const code of [undefined, null, "", "zh", "zh-CN", "zh-TW", "ZH-hk"]) assert.equal(languageFor(code), "zh");
    for (const code of ["en", "en-GB", "fr", "ja"]) assert.equal(languageFor(code), "en");
    assert.equal(languageForPreference("auto", "zh-CN"), "zh");
    assert.equal(languageForPreference("auto", "en-US"), "en");
    assert.equal(languageForPreference("zh", "en-US"), "zh");
    assert.equal(languageForPreference("en", "zh-CN"), "en");
    try {
      setLanguage("en");
      assert.equal(locale(), "en-US");
      assert.equal(t("创建「{0}」", "中文标题 {1}"), "Created “中文标题 {1}”");
      assert.equal(t("unregistered fallback"), "unregistered fallback");
      setLanguage("zh-TW");
      assert.equal(locale(), "zh-CN");
      assert.equal(t("创建「{0}」", "中文标题 {1}"), "创建「中文标题 {1}」");
    } finally { setLanguage(null); }
  });

  await test("English APIs preserve Chinese notes while localizing hints and insights", async () => {
    try {
      setLanguage("en");
      const result = await api("POST", "/api/nodes", { title: "中文原始标题", content: "保留正文。", background: "原始背景" });
      assert.equal(result.status, 201);
      const resolved = await api("GET", new URL(result.data.link).pathname);
      assert.equal(resolved.data.title, "中文原始标题");
      assert.equal(resolved.data.content, "保留正文。");
      assert.equal(resolved.data.background, "原始背景");
      assert.match(resolved.data.hint, /^Read through this link/);
      const insights = await store.getDashboardInsights();
      assert.ok(insights.weeklyTrend.every((point) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].includes(point.label)));
      assert.ok(insights.weekly.every((entry) => !/\p{Script=Han}/u.test(entry.reason)));
      const invalid = await api("POST", "/api/nodes", { title: "" });
      assert.equal(invalid.error, "Title cannot be empty");
      setLanguage("zh");
      const original = await api("GET", new URL(result.data.link).pathname);
      assert.equal(original.data.title, resolved.data.title);
      assert.match(original.data.hint, /^优先通过本链接读取/);
    } finally { setLanguage(null); }
  });

  await test("English Skill and installation task retain every endpoint and identity requirement", async () => {
    const chinese = renderSharedSkillMd(port);
    try {
      setLanguage("en");
      const english = await (await fetch(`${base}/api/skill.md`)).text();
      assert.equal(english, renderSharedSkillMd(port));
      assert.doesNotMatch(english, /\p{Script=Han}/u);
      assert.match(english, /do not modify/i);
      assert.match(english, /X-AgentNote-Agent-Id/);
      assert.match(english, /X-AgentNote-Session-Title/);
      const endpoints = (value) => [...value.matchAll(/^(?:GET|POST|PATCH)\s+http:\/\/127\.0\.0\.1:\d+\/api\/[^\s]+/gm)].map((match) => match[0]);
      assert.deepEqual(endpoints(english), endpoints(chinese));
      const install = renderManualInstallPrompt({ port });
      assert.doesNotMatch(install, /\p{Script=Han}/u);
      for (const route of ["/api/skill.md", "/api/agents/register", "/api/skill-icon.ico"]) assert.ok(install.includes(`${base}${route}`));
      assert.match(install, /agentnote.identity.json/);
      assert.match(install, /skillPath/);
    } finally { setLanguage(null); }
  });

  await test("switching languages preserves installed Skills and editable additional instructions", async () => {
    const dir = path.join(identityRoot, "bilingual-skill");
    const options = { port, agentId: "bilingual-agent", agentName: "My Agent" };
    installSkill(dir, options);
    const original = await fsp.readFile(path.join(dir, "SKILL.md"), "utf8");
    const first = withSkillInstructions(original, "保留我的中文要求。");
    try {
      setLanguage("en");
      assert.equal(skillStatus(dir, options), "current");
      assert.equal(await fsp.readFile(path.join(dir, "SKILL.md"), "utf8"), original);
      assert.equal(splitSkillInstructions(first).additional, "保留我的中文要求。");
      const updated = withSkillInstructions(splitSkillInstructions(first).base, "My custom instructions.");
      assert.match(updated, /## Additional instructions/);
      assert.equal(updated.match(/<!-- agentNote:additional -->/g).length, 1);
      installSkill(path.join(identityRoot, "english-skill"), options);
      assert.equal(skillStatus(path.join(identityRoot, "english-skill"), options), "current");
      setLanguage("zh");
      assert.equal(splitSkillInstructions(updated).additional, "My custom instructions.");
      assert.equal(skillStatus(path.join(identityRoot, "english-skill"), options), "current");
      assert.equal(withSkillInstructions(splitSkillInstructions(updated).base, ""), original);
    } finally { setLanguage(null); }
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
  await fsp.rm(identityRoot, { recursive: true, force: true });
}
