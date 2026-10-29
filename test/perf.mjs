/**
 * 性能回归门槛：用固定规模的合成数据跑真实代码路径，防止聚合或存储退化回
 * 「每次刷新都全量解析 / 全量计算」的老路。阈值留了数倍余量，只拦数量级退化。
 */
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { VaultStore, ActivityLog } = require("./core-bundle.cjs");

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "agentnote-perf-"));
const deviceIdFile = path.join(root, "identity", "device-id");
const dataDir = path.join(root, "vault", "agentNote", "data");
const month = "2026-05";
const SHARDS = 1200;
const LEGACY = 1800;
const DOCUMENTS = 300;

const median = async (rounds, fn) => {
  const samples = [];
  for (let index = 0; index < rounds; index++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
};

try {
  const log = new ActivityLog(dataDir, { deviceIdFile });
  await log.init();
  const deviceId = (await fsp.readFile(deviceIdFile, "utf8")).trim();
  const at = `${month}-20T08:00:00.000Z`;
  const event = (index) => ({ eventId: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`, deviceId, at, type: index % 5 === 0 ? "share-resolved" : "local-edited", title: `资料 ${index}`, documentId: `d-${index % DOCUMENTS}`, path: `笔记/${index % DOCUMENTS}.md` });

  const shardDir = path.join(dataDir, "events", month);
  await fsp.mkdir(shardDir, { recursive: true });
  await Promise.all(Array.from({ length: SHARDS }, (_, index) => fsp.writeFile(path.join(shardDir, `${event(index).eventId}.json`), JSON.stringify(event(index), null, 2))));
  await fsp.writeFile(path.join(dataDir, `events.${deviceId}.json`), JSON.stringify(Array.from({ length: LEGACY }, (_, index) => event(SHARDS + index)), null, 2));

  const store = new VaultStore(path.join(root, "vault"), ".obsidian", { deviceIdFile, referencesFile: path.join(root, "identity", "references.json") });
  await store.init();

  const cold = await median(1, () => log.readReport());
  const warm = await median(7, () => log.readReport());
  const summary = await median(7, () => store.getDashboardInsights(new Date(), "summary"));
  const full = await median(7, () => store.getDashboardInsights());
  const report = await log.readReport();
  const insights = await store.getDashboardInsights(new Date(), "summary");
  const profile = await store.getDashboardInsights();
  const lines = [
    `事件分片 ${SHARDS} + 聚合记录 ${LEGACY} 条，文档 ${DOCUMENTS} 篇`,
    `  readReport 首次 ${cold.toFixed(1)} ms · 命中缓存 ${warm.toFixed(1)} ms`,
    `  getDashboardInsights summary ${summary.toFixed(1)} ms · full ${full.toFixed(1)} ms`,
  ];
  console.log(lines.join("\n"));

  assert.equal(report.issues.length, 0);
  assert.equal(report.events.length, SHARDS + LEGACY, "事件去重后应保留全部记录");
  assert.equal(insights.activities.length, 10, "首屏只取最近 10 条动态");
  assert.equal(profile.documents.length, DOCUMENTS, "完整档案仍需文档贡献");
  assert.deepEqual(insights.documents, [], "summary 档不计算文档贡献");
  assert.deepEqual(insights.timeline, [], "summary 档不返回完整时间线");
  assert.deepEqual(insights.archiveCandidates, [], "summary 档不计算整理建议");
  assert.ok(warm < cold, `缓存命中应快于首次解析（${warm.toFixed(1)} vs ${cold.toFixed(1)} ms）`);
  assert.ok(warm < 25, `readReport 命中缓存 ${warm.toFixed(1)} ms 超出 25 ms 门槛`);
  assert.ok(summary < 35, `getDashboardInsights(summary) ${summary.toFixed(1)} ms 超出 35 ms 门槛`);
  assert.ok(full < 60, `getDashboardInsights(full) ${full.toFixed(1)} ms 超出 60 ms 门槛`);
  console.log("PASS performance stays within the recorded budget");
} finally {
  await fsp.rm(root, { recursive: true, force: true });
}
