import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { randomBytes } from "crypto";
import { isNodeFile, parseNode, serializeNode } from "./nodeFile";
import { AgentNode, NodeSource, NodeType, Share, ShareTarget, normalizeTags, qualityWarnings, shareTarget } from "./types";

export class StoreError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export interface NodeFilter { q?: string; type?: NodeType; archived?: boolean }
export interface CreateNodeInput {
  type?: NodeType;
  title: string;
  content?: string;
  background?: string;
  tags?: string[];
  source?: NodeSource;
  path?: string;
  idempotencyKey?: string;
}
export interface UpdateNodeInput {
  title?: string;
  content?: string;
  background?: string;
  tags?: string[];
  path?: string;
  source?: NodeSource;
  archived?: boolean;
  pinned?: boolean;
}

export type InsightEventType = "node-created" | "node-updated" | "node-archived" | "node-restored" | "share-resolved";
export interface ActivityActor { name: string; sessionTitle?: string; id?: string }
export interface ActivityContext { actor?: ActivityActor }
export interface InsightEvent {
  at: string;
  type: InsightEventType;
  nodeId?: string;
  shareId?: string;
  targetKind?: ShareTarget["kind"];
  title?: string;
  actor?: ActivityActor;
}
export interface InsightNote { node: AgentNode; reads: number; lastRead?: string; score: number; reason: string }
export interface InsightTrendPoint { label: string; count: number }
export interface DashboardInsights {
  summary: { weekCreated: number; weekResolves: number; weekUsedNotes: number; monthResolves: number };
  weekly: InsightNote[];
  monthly: InsightNote[];
  activities: InsightEvent[];
  timeline: InsightEvent[];
  weeklyTrend: InsightTrendPoint[];
  monthlyTrend: InsightTrendPoint[];
  archiveCandidates: AgentNode[];
}
export interface AgentInsight { name: string; uses: number; created: number; updated: number; lastActive: string }
export interface DocumentInsight { nodeId?: string; title: string; uses: number; agents: string[]; lastUsed: string }

export type ShareResult =
  | { shareId: string; kind: "text"; title: string; background: string; content: string; updated: string; filePath: string; hint: string }
  | { shareId: string; kind: "file"; title: string; background: string; address: string; content: string; updated: string; filePath: string; hint: string }
  | { shareId: string; kind: "folder"; title: string; background: string; address: string; entries: string[]; updated: string; filePath: string; hint: string };

/** Tells the receiving agent how to use filePath: the link stays the read
 *  entry; local file access (when available) is the edit entry. */
const SHARE_HINT = "优先通过本链接读取：它是活引用，始终返回当前内容。需要修改时，具备本地文件能力的 agent 可直接编辑 filePath 指向的本地文件，无需全量重写。";

function newId(prefix: string): string { return `${prefix}-${randomBytes(6).toString("hex")}`; }
function safeFileBase(title: string, fallback: string): string {
  return title.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 80) || fallback;
}

export class VaultStore {
  readonly root: string;
  readonly dataDir: string;
  private cache = new Map<string, { mtimeMs: number; node: AgentNode }>();
  private idToPath = new Map<string, string>();
  private idempotentCreates = new Map<string, Promise<AgentNode>>();

  constructor(vaultRoot: string) {
    this.root = path.resolve(vaultRoot);
    this.dataDir = path.join(this.root, "agentNote");
  }
  private p(...parts: string[]): string { return path.join(this.dataDir, ...parts); }

  async init(): Promise<void> {
    await Promise.all([fsp.mkdir(this.p("nodes"), { recursive: true }), fsp.mkdir(this.p("data"), { recursive: true })]);
    const shares = this.p("data", "shares.json");
    if (!fs.existsSync(shares)) await fsp.writeFile(shares, "[]", "utf8");
    const events = this.p("data", "events.json");
    if (!fs.existsSync(events)) await fsp.writeFile(events, "[]", "utf8");
  }

  private async markdownFiles(dir: string): Promise<string[]> {
    const result: string[] = [];
    const walk = async (current: string) => {
      for (const item of await fsp.readdir(current, { withFileTypes: true })) {
        const full = path.join(current, item.name);
        if (item.isDirectory()) await walk(full);
        else if (item.isFile() && item.name.endsWith(".md")) result.push(full);
      }
    };
    if (fs.existsSync(dir)) await walk(dir);
    return result;
  }

  private async scanNodes(): Promise<AgentNode[]> {
    const dir = this.p("nodes");
    const files = await this.markdownFiles(dir);
    const next = new Map<string, string>();
    const nodes: AgentNode[] = [];
    for (const file of files) {
      try {
        const stat = await fsp.stat(file);
        const hit = this.cache.get(file);
        if (hit?.mtimeMs === stat.mtimeMs) { nodes.push(hit.node); next.set(hit.node.id, file); continue; }
        const raw = await fsp.readFile(file, "utf8");
        if (!isNodeFile(raw)) continue;
        const rel = path.relative(dir, file).split(path.sep);
        const node = parseNode(raw, {
          title: path.basename(file, ".md"),
          created: stat.birthtime.toISOString(),
          updated: stat.mtime.toISOString(),
          archived: rel[0] === "归档",
        });
        this.cache.set(file, { mtimeMs: stat.mtimeMs, node });
        next.set(node.id, file);
        nodes.push(node);
      } catch { /* user files remain untouched even if malformed */ }
    }
    this.idToPath = next;
    return nodes;
  }

  async listNodes(filter: NodeFilter = {}): Promise<AgentNode[]> {
    let nodes = await this.scanNodes();
    if (filter.type) nodes = nodes.filter((node) => node.type === filter.type);
    if (filter.archived !== undefined) nodes = nodes.filter((node) => node.archived === filter.archived);
    if (filter.q) {
      const q = filter.q.toLowerCase();
      nodes = nodes.filter((node) => [node.title, node.content, node.background, ...node.tags].some((v) => v.toLowerCase().includes(q)));
    }
    return nodes.sort((a, b) => b.updated.localeCompare(a.updated));
  }
  async getNode(id: string): Promise<AgentNode> {
    const node = (await this.scanNodes()).find((candidate) => candidate.id === id);
    if (!node) throw new StoreError(404, `笔记不存在: ${id}`);
    return node;
  }
  async nodeFilePath(id: string): Promise<string> {
    await this.scanNodes();
    const file = this.idToPath.get(id);
    if (!file) throw new StoreError(404, `笔记不存在: ${id}`);
    return path.relative(this.root, file).split(path.sep).join("/");
  }
  private async nodeFileAbsPath(id: string): Promise<string> {
    await this.scanNodes();
    const file = this.idToPath.get(id);
    if (!file) throw new StoreError(404, `笔记不存在: ${id}`);
    return file;
  }

  private async nodePath(title: string, id: string, archived: boolean): Promise<string> {
    const dir = archived ? this.p("nodes", "归档") : this.p("nodes");
    await fsp.mkdir(dir, { recursive: true });
    const base = safeFileBase(title, id);
    for (let n = 1; ; n++) {
      const candidate = path.join(dir, `${base}${n === 1 ? "" : ` ${n}`}.md`);
      if (!fs.existsSync(candidate) || this.idToPath.get(id) === candidate) return candidate;
    }
  }
  private async writeNode(node: AgentNode): Promise<void> {
    await this.scanNodes();
    const destination = await this.nodePath(node.title, node.id, node.archived);
    const previous = this.idToPath.get(node.id);
    await fsp.writeFile(destination, serializeNode(node), "utf8");
    if (previous && previous !== destination) await fsp.rm(previous, { force: true });
    const stat = await fsp.stat(destination);
    this.cache.set(destination, { mtimeMs: stat.mtimeMs, node: { ...node, updated: stat.mtime.toISOString() } });
    this.idToPath.set(node.id, destination);
  }

  private async readIdempotencyKeys(): Promise<Record<string, string>> {
    try {
      const value = JSON.parse(await fsp.readFile(this.p("data", "idempotency.json"), "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }
  private async writeIdempotencyKeys(keys: Record<string, string>): Promise<void> {
    await fsp.writeFile(this.p("data", "idempotency.json"), JSON.stringify(keys, null, 2), "utf8");
  }

  async createNode(input: CreateNodeInput, idempotencyKey?: string, context: ActivityContext = {}): Promise<AgentNode> {
    if (!input.title?.trim()) throw new StoreError(400, "标题不能为空");
    const key = idempotencyKey?.trim();
    if (key) {
      const active = this.idempotentCreates.get(key);
      if (active) return active;
      const operation = this.createNodeWithKey(input, key, context);
      this.idempotentCreates.set(key, operation);
      try { return await operation; } finally { this.idempotentCreates.delete(key); }
    }
    return this.createNodeWithKey(input, undefined, context);
  }
  private async createNodeWithKey(input: CreateNodeInput, idempotencyKey?: string, context: ActivityContext = {}): Promise<AgentNode> {
    if (idempotencyKey) {
      const keys = await this.readIdempotencyKeys();
      const existingId = keys[idempotencyKey];
      if (existingId) {
        try { return await this.getNode(existingId); }
        catch (error) { if (!(error instanceof StoreError) || error.statusCode !== 404) throw error; delete keys[idempotencyKey]; await this.writeIdempotencyKeys(keys); }
      }
    }
    const type = input.type ?? "snippet";
    if ((type === "file" || type === "folder") && !input.path?.trim()) throw new StoreError(400, `${type} 笔记需要文件地址`);
    const now = new Date().toISOString();
    const node: AgentNode = { id: newId("n"), type, title: input.title.trim(), content: input.content ?? "", background: input.background?.trim() ?? "", tags: normalizeTags(input.tags), source: input.source ?? "agent", path: input.path?.trim() || undefined, created: now, updated: now, archived: false, pinned: false };
    await this.writeNode(node);
    if (idempotencyKey) {
      const keys = await this.readIdempotencyKeys();
      keys[idempotencyKey] = node.id;
      await this.writeIdempotencyKeys(keys);
    }
    await this.recordEvent({ type: "node-created", nodeId: node.id, title: node.title, actor: context.actor }).catch(() => undefined);
    return node;
  }
  async updateNode(id: string, patch: UpdateNodeInput, context: ActivityContext = {}): Promise<AgentNode> {
    const node = await this.getNode(id);
    if (patch.title !== undefined) node.title = patch.title.trim();
    if (patch.content !== undefined) node.content = patch.content;
    if (patch.background !== undefined) node.background = patch.background;
    if (patch.tags !== undefined) node.tags = normalizeTags(patch.tags);
    if (patch.path !== undefined) node.path = patch.path || undefined;
    if (patch.source !== undefined) node.source = patch.source;
    const archivedChanged = patch.archived !== undefined && patch.archived !== node.archived;
    if (patch.archived !== undefined) node.archived = patch.archived;
    if (patch.pinned !== undefined) node.pinned = patch.pinned;
    node.updated = new Date().toISOString();
    await this.writeNode(node);
    await this.recordEvent({ type: archivedChanged ? (node.archived ? "node-archived" : "node-restored") : "node-updated", nodeId: node.id, title: node.title, actor: context.actor }).catch(() => undefined);
    return node;
  }
  async archiveNode(id: string, archived: boolean, context: ActivityContext = {}): Promise<AgentNode> {
    const node = await this.getNode(id);
    node.archived = archived;
    await this.writeNode(node);
    await this.recordEvent({ type: archived ? "node-archived" : "node-restored", nodeId: node.id, title: node.title, actor: context.actor }).catch(() => undefined);
    return node;
  }
  async archiveNodes(ids: string[], archived: boolean): Promise<AgentNode[]> {
    const changed: AgentNode[] = [];
    for (const id of ids) changed.push(await this.archiveNode(id, archived));
    return changed;
  }

  private async readShares(): Promise<Share[]> {
    try {
      const shares = JSON.parse(await fsp.readFile(this.p("data", "shares.json"), "utf8"));
      if (!Array.isArray(shares)) return [];
      return shares.map((share) => ({ ...share, target: shareTarget(share as Share) }));
    } catch { return []; }
  }
  private async writeShares(shares: Share[]): Promise<void> { await fsp.writeFile(this.p("data", "shares.json"), JSON.stringify(shares, null, 2), "utf8"); }
  async listShares(): Promise<Share[]> { return this.readShares(); }
  private async appendShare(target: ShareTarget, selection?: string, background?: string): Promise<Share> {
    const share: Share = { id: newId("s-x"), target, selection, background: background?.trim() || undefined, created: new Date().toISOString() };
    const shares = await this.readShares(); shares.push(share); await this.writeShares(shares); return share;
  }
  async createShare(nodeId: string, selection?: string): Promise<Share> {
    const node = await this.getNode(nodeId);
    if (selection && node.type !== "snippet") throw new StoreError(400, "只有文本笔记能分享选段");
    if (selection && !node.content.includes(selection)) throw new StoreError(400, "选段已不在当前正文中");
    return this.appendShare({ kind: "node", nodeId }, selection);
  }
  /** Every written node gets a whole-note share link; reuse the existing one
   *  so the link returned at write time stays the canonical address. */
  async ensureShareForNode(nodeId: string): Promise<Share> {
    const existing = (await this.readShares()).find((share) => share.target.kind === "node" && share.target.nodeId === nodeId && !share.selection);
    return existing ?? this.createShare(nodeId);
  }
  private vaultPath(relPath: string): { rel: string; abs: string } {
    const rel = relPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!rel || rel.split("/").includes("..")) throw new StoreError(400, "必须提供 vault 内相对路径");
    return { rel, abs: path.join(this.root, ...rel.split("/")) };
  }
  async createPathShare(relPath: string, background?: string, selection?: string): Promise<Share> {
    const { rel, abs } = this.vaultPath(relPath);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat) throw new StoreError(404, `找不到内容: ${rel}`);
    if (stat.isDirectory()) { if (selection) throw new StoreError(400, "文件夹不能分享选段"); return this.appendShare({ kind: "folder", path: rel }, undefined, background); }
    if (selection && !(await fsp.readFile(abs, "utf8")).includes(selection)) throw new StoreError(400, "选段已不在当前文件中");
    return this.appendShare({ kind: "file", path: rel }, selection, background);
  }

  async resolveShare(id: string, context: ActivityContext = {}): Promise<ShareResult> {
    const share = (await this.readShares()).find((candidate) => candidate.id === id);
    if (!share) throw new StoreError(404, `分享不存在: ${id}`);
    let result: ShareResult;
    if (share.target.kind === "node") {
      result = await this.resolveNodeShare(share, await this.getNode(share.target.nodeId));
    } else {
      const target = share.target;
      const { rel, abs } = this.vaultPath(target.path);
      result = target.kind === "file" ? await this.resolveFileShare(share, rel, abs) : await this.resolveFolderShare(share, rel, abs);
    }
    await this.recordEvent({ type: "share-resolved", shareId: share.id, nodeId: share.target.kind === "node" ? share.target.nodeId : undefined, targetKind: share.target.kind, title: result.title, actor: context.actor }).catch(() => undefined);
    return result;
  }

  private async readEvents(): Promise<InsightEvent[]> {
    try {
      const events = JSON.parse(await fsp.readFile(this.p("data", "events.json"), "utf8"));
      if (!Array.isArray(events)) return [];
      const valid = events.filter((event): event is InsightEvent => !!event && typeof event.at === "string" && typeof event.type === "string");
      const shares = new Map((await this.readShares()).map((share) => [share.id, share]));
      return Promise.all(valid.map(async (event) => {
        if (event.title || !event.shareId) return event;
        const share = shares.get(event.shareId);
        if (!share) return event;
        if (share.target.kind !== "node") return { ...event, title: path.basename(share.target.path).replace(/\.md$/i, "") };
        try { return { ...event, title: (await this.getNode(share.target.nodeId)).title }; }
        catch { return event; }
      }));
    } catch { return []; }
  }
  private async recordEvent(event: Omit<InsightEvent, "at">): Promise<void> {
    const events = await this.readEvents();
    events.push({ ...event, at: new Date().toISOString() });
    await fsp.writeFile(this.p("data", "events.json"), JSON.stringify(events, null, 2), "utf8");
  }
  async getDashboardInsights(now = new Date()): Promise<DashboardInsights> {
    const nodes = await this.listNodes();
    const events = await this.readEvents();
    const weekStart = new Date(now); weekStart.setHours(0, 0, 0, 0); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const archiveBefore = new Date(now); archiveBefore.setDate(archiveBefore.getDate() - 30);
    const inRange = (at: string, start: Date) => new Date(at) >= start && new Date(at) <= now;
    const resolveEvents = events.filter((event) => event.type === "share-resolved");
    const buildRanking = (start: Date, monthly: boolean): InsightNote[] => {
      const usage = new Map<string, InsightEvent[]>();
      for (const event of resolveEvents.filter((event) => event.nodeId && inRange(event.at, start))) {
        const items = usage.get(event.nodeId!) ?? []; items.push(event); usage.set(event.nodeId!, items);
      }
      return nodes.filter((node) => !node.archived && usage.has(node.id)).map((node) => {
        const reads = usage.get(node.id)!;
        const distinctWeeks = new Set(reads.map((event) => {
          const date = new Date(event.at); const monday = new Date(date); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7)); return monday.toISOString().slice(0, 10);
        })).size;
        const updated = inRange(node.updated, start);
        const score = monthly ? distinctWeeks * 1000 + reads.length * 10 + (updated ? 1 : 0) : reads.length * 10 + (updated ? 1 : 0);
        const lastRead = reads.map((event) => event.at).sort().at(-1);
        const reason = monthly ? `本月被读取 ${reads.length} 次，跨 ${distinctWeeks} 周复用` : `本周被读取 ${reads.length} 次${updated ? "，并在本周更新" : ""}`;
        return { node, reads: reads.length, lastRead, score, reason };
      }).sort((a, b) => b.score - a.score || (b.lastRead ?? "").localeCompare(a.lastRead ?? "")).slice(0, 3);
    };
    const usedNodeIds = new Set(resolveEvents.filter((event) => event.nodeId && inRange(event.at, weekStart)).map((event) => event.nodeId));
    const everUsed = new Set(resolveEvents.flatMap((event) => event.nodeId ? [event.nodeId] : []));
    const trend = (start: Date, days: number, label: (date: Date) => string): InsightTrendPoint[] => Array.from({ length: days }, (_, index) => {
      const from = new Date(start); from.setDate(from.getDate() + index);
      const until = new Date(from); until.setDate(until.getDate() + 1);
      return { label: label(from), count: resolveEvents.filter((event) => new Date(event.at) >= from && new Date(event.at) < until).length };
    });
    const monthDays = Math.max(1, Math.ceil((now.getTime() - monthStart.getTime()) / 86_400_000) + 1);
    return {
      summary: {
        weekCreated: nodes.filter((node) => inRange(node.created, weekStart)).length,
        weekResolves: resolveEvents.filter((event) => inRange(event.at, weekStart)).length,
        weekUsedNotes: usedNodeIds.size,
        monthResolves: resolveEvents.filter((event) => inRange(event.at, monthStart)).length,
      },
      weekly: buildRanking(weekStart, false),
      monthly: buildRanking(monthStart, true),
      activities: events.filter((event) => inRange(event.at, weekStart)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10),
      timeline: [...events].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100),
      weeklyTrend: trend(weekStart, 7, (date) => ["日", "一", "二", "三", "四", "五", "六"][date.getDay()]),
      monthlyTrend: trend(monthStart, monthDays, (date) => String(date.getDate())),
      archiveCandidates: nodes.filter((node) => !node.archived && !node.pinned && new Date(node.created) <= archiveBefore && new Date(node.updated) <= archiveBefore && !everUsed.has(node.id)).sort((a, b) => a.updated.localeCompare(b.updated)),
    };
  }
  async listActivity(filter: { from?: string; to?: string; agent?: string; action?: InsightEventType; nodeId?: string } = {}): Promise<InsightEvent[]> {
    return (await this.readEvents()).filter((event) => (!filter.from || event.at >= filter.from) && (!filter.to || event.at <= filter.to) && (!filter.agent || (event.actor?.name ?? event.actor?.id) === filter.agent) && (!filter.action || event.type === filter.action) && (!filter.nodeId || event.nodeId === filter.nodeId)).sort((a, b) => b.at.localeCompare(a.at));
  }
  async getAgentInsights(): Promise<AgentInsight[]> {
    const grouped = new Map<string, AgentInsight>();
    for (const event of await this.readEvents()) {
      if (!event.actor) continue;
      const name = event.actor.name ?? event.actor.id ?? "未申报 agent";
      const row = grouped.get(name) ?? { name, uses: 0, created: 0, updated: 0, lastActive: event.at };
      if (event.type === "share-resolved") row.uses++;
      if (event.type === "node-created") row.created++;
      if (event.type === "node-updated") row.updated++;
      if (event.at > row.lastActive) row.lastActive = event.at;
      grouped.set(row.name, row);
    }
    return [...grouped.values()].sort((a, b) => b.lastActive.localeCompare(a.lastActive));
  }
  async getDocumentInsights(): Promise<DocumentInsight[]> {
    const grouped = new Map<string, DocumentInsight>();
    for (const event of (await this.readEvents()).filter((event) => event.type === "share-resolved")) {
      const key = event.nodeId ?? `${event.targetKind}:${event.title ?? event.shareId}`;
      const row = grouped.get(key) ?? { nodeId: event.nodeId, title: event.title ?? "未命名资料", uses: 0, agents: [], lastUsed: event.at };
      row.uses++;
      const actorName = event.actor?.name ?? event.actor?.id;
      if (actorName && !row.agents.includes(actorName)) row.agents.push(actorName);
      if (event.at > row.lastUsed) row.lastUsed = event.at;
      grouped.set(key, row);
    }
    return [...grouped.values()].sort((a, b) => b.uses - a.uses || b.lastUsed.localeCompare(a.lastUsed));
  }
  private async resolveNodeShare(share: Share, node: AgentNode): Promise<ShareResult> {
    if (node.type === "snippet") {
      const content = share.selection ?? node.content;
      if (share.selection && !node.content.includes(share.selection)) throw new StoreError(410, "分享选段已不在当前正文中");
      return { shareId: share.id, kind: "text", title: node.title, background: node.background, content, updated: node.updated, filePath: await this.nodeFileAbsPath(node.id), hint: SHARE_HINT };
    }
    if (!node.path) throw new StoreError(410, "笔记缺少文件地址");
    const stat = await fsp.stat(node.path).catch(() => null);
    if (!stat) throw new StoreError(410, "分享目标已不存在");
    return stat.isDirectory() ? this.resolveFolderShare(share, node.path, node.path, node.background, node.title) : this.resolveFileShare(share, node.path, node.path, node.background, node.title);
  }
  private async resolveFileShare(share: Share, address: string, abs: string, background = share.background ?? "", title = path.basename(address)): Promise<ShareResult> {
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw new StoreError(410, `分享文件已不存在: ${address}`);
    const body = await fsp.readFile(abs, "utf8");
    const content = share.selection ?? body;
    if (share.selection && !body.includes(share.selection)) throw new StoreError(410, "分享选段已不在当前文件中");
    return { shareId: share.id, kind: "file", title, background, address, content, updated: stat.mtime.toISOString(), filePath: abs, hint: SHARE_HINT };
  }
  private async resolveFolderShare(share: Share, address: string, abs: string, background = share.background ?? "", title = path.basename(address)): Promise<ShareResult> {
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat?.isDirectory()) throw new StoreError(410, `分享文件夹已不存在: ${address}`);
    const entries = (await fsp.readdir(abs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)).map((item) => item.isDirectory() ? `${item.name}/` : item.name);
    return { shareId: share.id, kind: "folder", title, background, address, entries, updated: stat.mtime.toISOString(), filePath: abs, hint: SHARE_HINT };
  }

  warningsFor(node: AgentNode) { return qualityWarnings(node); }
}
