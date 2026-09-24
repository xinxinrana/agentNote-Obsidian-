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

export type InsightEventType = "node-created" | "node-updated" | "node-archived" | "node-restored" | "share-created" | "share-resolved" | "local-created" | "local-edited" | "local-read" | "local-moved" | "local-deleted" | "document-linked";
export interface ActivityActor { name: string; sessionTitle?: string; id?: string }
export interface ActivityContext { actor?: ActivityActor }
interface RegisteredAgent { id: string; name: string }
export interface VaultDocument {
  id: string;
  path: string;
  title: string;
  created: string;
  updated: string;
  deletedAt?: string;
  protected?: boolean;
}
export interface InsightEvent {
  at: string;
  type: InsightEventType;
  origin?: "local" | "agent" | "link";
  documentId?: string;
  path?: string;
  sourcePath?: string;
  nodeId?: string;
  shareId?: string;
  targetKind?: ShareTarget["kind"];
  title?: string;
  actor?: ActivityActor;
}
export interface InsightNote { node: AgentNode; reads: number; lastRead?: string; score: number; reason: string }
export interface InsightTrendPoint { label: string; count: number }
export type ContributionCategory = "construction" | "reuse" | "connection" | "organization";
export interface DocumentContribution {
  document: VaultDocument;
  score: number;
  recentScore: number;
  construction: number;
  reuse: number;
  connection: number;
  organization: number;
  lastActive?: string;
}
export interface ArchiveCandidate {
  document: VaultDocument;
  node?: AgentNode;
  reason: string;
  uses: number;
  lastUsed?: string;
}
export interface DashboardInsights {
  summary: {
    weekActivityScore: number;
    allTimeActivityScore: number;
    weekActivityCount: number;
    weekCreated: number;
    weekUpdated: number;
    weekSharesCreated: number;
    weekResolves: number;
    weekUsedNotes: number;
    monthResolves: number;
  };
  weekly: InsightNote[];
  weeklyDocuments: DocumentContribution[];
  monthly: InsightNote[];
  allTime: InsightNote[];
  activities: InsightEvent[];
  timeline: InsightEvent[];
  weeklyTrend: InsightTrendPoint[];
  monthlyTrend: InsightTrendPoint[];
  allTimeTrend: InsightTrendPoint[];
  documents: DocumentContribution[];
  startedAt: string;
  archiveCandidates: ArchiveCandidate[];
  protectedDocuments: VaultDocument[];
  protectedNodes: AgentNode[];
}
export interface AgentInsight { name: string; uses: number; created: number; updated: number; lastActive: string }
export interface DocumentInsight { nodeId?: string; title: string; uses: number; agents: string[]; lastUsed: string }

export type ShareResult =
  | { shareId: string; kind: "text"; title: string; background: string; content: string; updated: string; filePath: string; hint: string }
  | { shareId: string; kind: "file"; title: string; background: string; address: string; content: string; updated: string; filePath: string; hint: string }
  | { shareId: string; kind: "folder"; title: string; background: string; address: string; entries: string[]; updated: string; filePath: string; hint: string };

/** Tells the receiving agent how to update the explicitly shared content. */
const SHARE_HINT = "优先通过本链接读取。更新已分享内容时，PATCH /api/shares/<shareId>，请求体为 { content: 更新后的完整内容 }。";
export const ACTIVITY_WEIGHTS: Partial<Record<InsightEventType, number>> = {
  "node-created": 4,
  "node-updated": 3,
  "node-archived": 3,
  "node-restored": 2,
  "share-created": 2,
  "share-resolved": 3,
  "local-created": 6,
  "local-edited": 6,
  "local-read": 4,
  "local-moved": 4,
  "local-deleted": 4,
  "document-linked": 5,
};

export function contributionCategory(event: InsightEvent): ContributionCategory {
  if (["node-created", "node-updated", "local-created", "local-edited"].includes(event.type)) return "construction";
  if (["share-created", "share-resolved", "local-read"].includes(event.type)) return "reuse";
  if (event.type === "document-linked") return "connection";
  return "organization";
}

function newId(prefix: string): string { return `${prefix}-${randomBytes(6).toString("hex")}`; }
function safeFileBase(title: string, fallback: string): string {
  return title.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 80) || fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export class VaultStore {
  readonly root: string;
  readonly dataDir: string;
  private cache = new Map<string, { mtimeMs: number; node: AgentNode }>();
  private idToPath = new Map<string, string>();
  private idempotentCreates = new Map<string, Promise<AgentNode>>();
  private eventWriteQueue: Promise<void> = Promise.resolve();
  private documentWriteQueue: Promise<void> = Promise.resolve();
  private referenceWriteQueue: Promise<void> = Promise.resolve();
  private suppressedLocalPaths = new Map<string, number>();

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
    const documents = this.p("data", "documents.json");
    if (!fs.existsSync(documents)) await fsp.writeFile(documents, "[]", "utf8");
    const references = this.p("data", "references.json");
    if (!fs.existsSync(references)) await fsp.writeFile(references, "{}", "utf8");
  }

  private normalizeVaultPath(filePath: string): string {
    const absolute = path.resolve(this.root, filePath);
    if (absolute !== this.root && !absolute.startsWith(`${this.root}${path.sep}`)) throw new StoreError(400, "文件路径不在当前 vault 中");
    return path.relative(this.root, absolute).split(path.sep).join("/");
  }
  private documentTitle(filePath: string): string { return path.basename(filePath, ".md") || "未命名文档"; }
  private async readDocuments(): Promise<VaultDocument[]> {
    try {
      const documents: unknown = JSON.parse(await fsp.readFile(this.p("data", "documents.json"), "utf8")) as unknown;
      if (!Array.isArray(documents)) return [];
      return documents.filter((document: unknown): document is VaultDocument => isRecord(document) && typeof document.id === "string" && typeof document.path === "string" && typeof document.title === "string" && typeof document.created === "string" && typeof document.updated === "string");
    } catch { return []; }
  }
  private async writeDocuments(documents: VaultDocument[]): Promise<void> {
    await fsp.writeFile(this.p("data", "documents.json"), JSON.stringify(documents, null, 2), "utf8");
  }
  private async updateDocuments<T>(update: (documents: VaultDocument[]) => Promise<T> | T): Promise<T> {
    let result!: T;
    const task = this.documentWriteQueue.then(async () => {
      const documents = await this.readDocuments();
      result = await update(documents);
      await this.writeDocuments(documents);
    });
    this.documentWriteQueue = task.catch(() => undefined);
    await task;
    return result;
  }
  private async ensureDocument(filePath: string, touch = true): Promise<VaultDocument> {
    const normalized = this.normalizeVaultPath(filePath);
    const now = new Date().toISOString();
    return this.updateDocuments((documents) => {
      const existing = documents.find((document) => document.path === normalized);
      if (existing) {
        existing.title = this.documentTitle(normalized); if (touch) existing.updated = now; delete existing.deletedAt;
        return existing;
      }
      const document: VaultDocument = { id: newId("d"), path: normalized, title: this.documentTitle(normalized), created: now, updated: now };
      documents.push(document); return document;
    });
  }
  private async moveDocument(filePath: string, oldPath: string): Promise<VaultDocument> {
    const normalized = this.normalizeVaultPath(filePath);
    const oldNormalized = this.normalizeVaultPath(oldPath);
    const now = new Date().toISOString();
    return this.updateDocuments((documents) => {
      const existing = documents.find((document) => document.path === oldNormalized) ?? documents.find((document) => document.path === normalized);
      if (existing) {
        existing.path = normalized; existing.title = this.documentTitle(normalized); existing.updated = now; delete existing.deletedAt;
        return existing;
      }
      const document: VaultDocument = { id: newId("d"), path: normalized, title: this.documentTitle(normalized), created: now, updated: now };
      documents.push(document); return document;
    });
  }
  private async deleteDocument(filePath: string): Promise<VaultDocument> {
    const normalized = this.normalizeVaultPath(filePath);
    const now = new Date().toISOString();
    return this.updateDocuments((documents) => {
      const existing = documents.find((document) => document.path === normalized);
      if (existing) { existing.updated = now; existing.deletedAt = now; return existing; }
      const document: VaultDocument = { id: newId("d"), path: normalized, title: this.documentTitle(normalized), created: now, updated: now, deletedAt: now };
      documents.push(document); return document;
    });
  }
  async protectDocument(documentId: string, protectedValue: boolean): Promise<void> {
    await this.updateDocuments((documents) => {
      const document = documents.find((candidate) => candidate.id === documentId && !candidate.deletedAt);
      if (!document) throw new StoreError(404, "文档不存在");
      document.protected = protectedValue;
    });
  }
  private suppressLocalActivity(filePath: string): void { this.suppressedLocalPaths.set(this.normalizeVaultPath(filePath), Date.now() + 30_000); }
  private consumeSuppressedLocalActivity(filePath: string): boolean {
    const normalized = this.normalizeVaultPath(filePath);
    const expiresAt = this.suppressedLocalPaths.get(normalized);
    if (!expiresAt) return false;
    if (expiresAt >= Date.now()) return true;
    this.suppressedLocalPaths.delete(normalized);
    return false;
  }
  async recordLocalActivity(type: Extract<InsightEventType, `local-${string}`>, filePath: string, oldPath?: string): Promise<boolean> {
    if (!filePath.toLowerCase().endsWith(".md") || this.normalizeVaultPath(filePath).startsWith(".obsidian/")) return false;
    if (type !== "local-moved" && this.consumeSuppressedLocalActivity(filePath)) return false;
    const document = type === "local-deleted" ? await this.deleteDocument(filePath) : type === "local-moved" && oldPath ? await this.moveDocument(filePath, oldPath) : await this.ensureDocument(filePath);
    await this.recordEvent({ type, documentId: document.id, path: document.path, title: document.title, origin: "local" });
    if (type === "local-moved" && oldPath) {
      await this.moveReferenceSource(oldPath, filePath);
      await this.moveShareTargets(oldPath, filePath);
    }
    return true;
  }
  private async moveShareTargets(oldPath: string, newPath: string): Promise<void> {
    const oldNormalized = this.normalizeVaultPath(oldPath);
    const newNormalized = this.normalizeVaultPath(newPath);
    const shares = await this.readShares();
    let changed = false;
    for (const share of shares) {
      if (share.target.kind !== "file" || this.normalizeVaultPath(share.target.path) !== oldNormalized) continue;
      share.target.path = newNormalized;
      changed = true;
    }
    if (changed) await this.writeShares(shares);
  }
  private async readReferences(): Promise<Record<string, string[]>> {
    try {
      const references: unknown = JSON.parse(await fsp.readFile(this.p("data", "references.json"), "utf8")) as unknown;
      if (!isRecord(references)) return {};
      return Object.fromEntries(Object.entries(references).filter(([, targets]) => Array.isArray(targets) && targets.every((target) => typeof target === "string"))) as Record<string, string[]>;
    } catch { return {}; }
  }
  async recordDocumentReferences(sourcePath: string, targetPaths: string[], recordAdditions = true): Promise<void> {
    const source = this.normalizeVaultPath(sourcePath);
    const targets = [...new Set(targetPaths.filter((target) => target.toLowerCase().endsWith(".md")).map((target) => this.normalizeVaultPath(target)).filter((target) => target !== source))].sort();
    const task = this.referenceWriteQueue.then(async () => {
      const references = await this.readReferences();
      const hasBaseline = Object.hasOwn(references, source);
      const previous = new Set(references[source] ?? []);
      references[source] = targets;
      await fsp.writeFile(this.p("data", "references.json"), JSON.stringify(references, null, 2), "utf8");
      if (!recordAdditions || !hasBaseline) return;
      for (const target of targets.filter((candidate) => !previous.has(candidate))) {
        const document = await this.ensureDocument(target, false);
        await this.recordEvent({ type: "document-linked", documentId: document.id, path: document.path, sourcePath: source, title: document.title, origin: "local" });
      }
    });
    this.referenceWriteQueue = task.catch(() => undefined);
    await task;
  }
  private async moveReferenceSource(oldPath: string, newPath: string): Promise<void> {
    const oldSource = this.normalizeVaultPath(oldPath);
    const newSource = this.normalizeVaultPath(newPath);
    const task = this.referenceWriteQueue.then(async () => {
      const references = await this.readReferences();
      let changed = false;
      if (references[oldSource]) { references[newSource] = references[oldSource]; delete references[oldSource]; changed = true; }
      for (const [source, targets] of Object.entries(references)) {
        if (!targets.includes(oldSource)) continue;
        references[source] = [...new Set(targets.map((target) => target === oldSource ? newSource : target))].sort();
        changed = true;
      }
      if (changed) await fsp.writeFile(this.p("data", "references.json"), JSON.stringify(references, null, 2), "utf8");
    });
    this.referenceWriteQueue = task.catch(() => undefined);
    await task;
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
    this.suppressLocalActivity(destination);
    if (previous && previous !== destination) this.suppressLocalActivity(previous);
    await fsp.writeFile(destination, serializeNode(node), "utf8");
    if (previous && previous !== destination) {
      await fsp.rm(previous, { force: true });
      await this.moveDocument(path.relative(this.root, destination), path.relative(this.root, previous));
      await this.moveReferenceSource(path.relative(this.root, previous), path.relative(this.root, destination));
    }
    const stat = await fsp.stat(destination);
    this.cache.set(destination, { mtimeMs: stat.mtimeMs, node: { ...node, updated: stat.mtime.toISOString() } });
    this.idToPath.set(node.id, destination);
  }
  private async documentIdForNode(nodeId: string): Promise<string | undefined> {
    try { return (await this.ensureDocument(await this.nodeFilePath(nodeId), false)).id; }
    catch { return undefined; }
  }
  private async documentIdForTarget(target: ShareTarget): Promise<string | undefined> {
    if (target.kind === "node") return this.documentIdForNode(target.nodeId);
    if (target.kind === "file" && target.path.toLowerCase().endsWith(".md")) return (await this.ensureDocument(target.path, false)).id;
    return undefined;
  }

  private async readIdempotencyKeys(): Promise<Record<string, string>> {
    try {
      const value: unknown = JSON.parse(await fsp.readFile(this.p("data", "idempotency.json"), "utf8")) as unknown;
      return isRecord(value) && Object.values(value).every((item) => typeof item === "string") ? value as Record<string, string> : {};
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
    await this.recordEvent({ type: "node-created", nodeId: node.id, documentId: await this.documentIdForNode(node.id), title: node.title, actor: context.actor, origin: context.actor ? "agent" : "local" }).catch(() => undefined);
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
    await this.recordEvent({ type: archivedChanged ? (node.archived ? "node-archived" : "node-restored") : "node-updated", nodeId: node.id, documentId: await this.documentIdForNode(node.id), title: node.title, actor: context.actor, origin: context.actor ? "agent" : "local" }).catch(() => undefined);
    return node;
  }
  async archiveNode(id: string, archived: boolean, context: ActivityContext = {}): Promise<AgentNode> {
    const node = await this.getNode(id);
    node.archived = archived;
    await this.writeNode(node);
    await this.recordEvent({ type: archived ? "node-archived" : "node-restored", nodeId: node.id, documentId: await this.documentIdForNode(node.id), title: node.title, actor: context.actor, origin: context.actor ? "agent" : "local" }).catch(() => undefined);
    return node;
  }
  async archiveNodes(ids: string[], archived: boolean): Promise<AgentNode[]> {
    const changed: AgentNode[] = [];
    for (const id of ids) changed.push(await this.archiveNode(id, archived));
    return changed;
  }

  private async readShares(): Promise<Share[]> {
    try {
      const shares: unknown = JSON.parse(await fsp.readFile(this.p("data", "shares.json"), "utf8")) as unknown;
      if (!Array.isArray(shares)) return [];
      return shares.filter(isRecord).map((share) => ({ ...share, target: shareTarget(share as unknown as Share) } as unknown as Share));
    } catch { return []; }
  }
  private async writeShares(shares: Share[]): Promise<void> { await fsp.writeFile(this.p("data", "shares.json"), JSON.stringify(shares, null, 2), "utf8"); }
  async listShares(): Promise<Share[]> { return this.readShares(); }
  private async readRegisteredAgents(): Promise<RegisteredAgent[]> {
    try {
      const agents: unknown = JSON.parse(await fsp.readFile(this.p("data", "agents.json"), "utf8")) as unknown;
      if (!Array.isArray(agents)) return [];
      return agents.filter((agent): agent is RegisteredAgent => isRecord(agent) && typeof agent.id === "string" && typeof agent.name === "string" && !!agent.id.trim() && !!agent.name.trim());
    } catch { return []; }
  }
  async registerAgent(agent: RegisteredAgent): Promise<void> {
    const id = agent.id.trim().toLowerCase().slice(0, 80);
    const name = agent.name.trim().slice(0, 80);
    if (!id || !name) throw new StoreError(400, "agent 身份不完整");
    const agents = await this.readRegisteredAgents();
    const index = agents.findIndex((item) => item.id === id);
    if (index === -1) agents.push({ id, name }); else agents[index] = { id, name };
    await fsp.writeFile(this.p("data", "agents.json"), JSON.stringify(agents, null, 2), "utf8");
  }
  async resolveActivityContext(context: ActivityContext): Promise<ActivityContext> {
    const actor = context.actor;
    const id = actor?.id?.trim().toLowerCase();
    if (!actor || !id) return context;
    const registered = (await this.readRegisteredAgents()).find((agent) => agent.id === id);
    return registered ? { actor: { id: registered.id, name: registered.name, sessionTitle: actor.sessionTitle } } : context;
  }
  private async appendShare(target: ShareTarget, selection?: string, background?: string, context: ActivityContext = {}, title?: string): Promise<Share> {
    const share: Share = { id: newId("s-x"), target, selection, background: background?.trim() || undefined, created: new Date().toISOString() };
    const shares = await this.readShares(); shares.push(share); await this.writeShares(shares);
    await this.recordEvent({ type: "share-created", shareId: share.id, nodeId: target.kind === "node" ? target.nodeId : undefined, documentId: await this.documentIdForTarget(target), targetKind: target.kind, title, actor: context.actor, origin: context.actor ? "agent" : "local" }).catch(() => undefined);
    return share;
  }
  async createShare(nodeId: string, selection?: string, context: ActivityContext = {}): Promise<Share> {
    const node = await this.getNode(nodeId);
    if (selection && node.type !== "snippet") throw new StoreError(400, "只有文本笔记能分享选段");
    if (selection && !node.content.includes(selection)) throw new StoreError(400, "选段已不在当前正文中");
    return this.appendShare({ kind: "node", nodeId }, selection, undefined, context, node.title);
  }
  /** Every written node gets a whole-note share link; reuse the existing one
   *  so the link returned at write time stays the canonical address. */
  async ensureShareForNode(nodeId: string, context: ActivityContext = {}): Promise<Share> {
    const existing = (await this.readShares()).find((share) => share.target.kind === "node" && share.target.nodeId === nodeId && !share.selection);
    return existing ?? this.createShare(nodeId, undefined, context);
  }
  private vaultPath(relPath: string): { rel: string; abs: string } {
    const rel = relPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!rel || rel.split("/").includes("..")) throw new StoreError(400, "必须提供 vault 内相对路径");
    return { rel, abs: path.join(this.root, ...rel.split("/")) };
  }
  async createPathShare(relPath: string, background?: string, selection?: string, context: ActivityContext = {}): Promise<Share> {
    const { rel, abs } = this.vaultPath(relPath);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat) throw new StoreError(404, `找不到内容: ${rel}`);
    const title = path.basename(rel).replace(/\.md$/i, "");
    if (stat.isDirectory()) { if (selection) throw new StoreError(400, "文件夹不能分享选段"); return this.appendShare({ kind: "folder", path: rel }, undefined, background, context, title); }
    if (selection && !(await fsp.readFile(abs, "utf8")).includes(selection)) throw new StoreError(400, "选段已不在当前文件中");
    return this.appendShare({ kind: "file", path: rel }, selection, background, context, title);
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
    await this.recordEvent({ type: "share-resolved", shareId: share.id, nodeId: share.target.kind === "node" ? share.target.nodeId : undefined, documentId: await this.documentIdForTarget(share.target), targetKind: share.target.kind, title: result.title, actor: context.actor, origin: context.actor ? "agent" : "link" }).catch(() => undefined);
    return result;
  }

  async updateShareContent(id: string, content: string, context: ActivityContext = {}): Promise<ShareResult> {
    const share = (await this.readShares()).find((candidate) => candidate.id === id);
    if (!share) throw new StoreError(404, `分享不存在: ${id}`);
    if (share.target.kind === "folder") throw new StoreError(400, "文件夹分享不支持通过接口直接修改");

    if (share.target.kind === "node") {
      const node = await this.getNode(share.target.nodeId);
      if (node.type === "snippet") {
        const nextContent = share.selection ? this.replaceSelection(node.content, share.selection, content) : content;
        if (share.selection) { share.selection = content; await this.replaceShare(share); }
        return this.resolveNodeShare(share, await this.updateNode(node.id, { content: nextContent }, context));
      }
      if (!node.path) throw new StoreError(410, "笔记缺少文件地址");
      return this.updateSharedFile(share, node.path, node.path, content, context, node.id, node.background, node.title);
    }

    const { rel, abs } = this.vaultPath(share.target.path);
    return this.updateSharedFile(share, rel, abs, content, context);
  }

  private replaceSelection(current: string, selection: string, replacement: string): string {
    if (!current.includes(selection)) throw new StoreError(410, "分享选段已不在当前文件中");
    return current.replace(selection, replacement);
  }

  private async replaceShare(share: Share): Promise<void> {
    const shares = await this.readShares();
    const index = shares.findIndex((candidate) => candidate.id === share.id);
    if (index === -1) throw new StoreError(404, `分享不存在: ${share.id}`);
    shares[index] = share;
    await this.writeShares(shares);
  }

  private async updateSharedFile(share: Share, address: string, abs: string, content: string, context: ActivityContext, nodeId?: string, background?: string, title?: string): Promise<ShareResult> {
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw new StoreError(400, "只有文本文件分享支持通过接口直接修改");
    const current = await fsp.readFile(abs, "utf8");
    const nextContent = share.selection ? this.replaceSelection(current, share.selection, content) : content;
    if (share.selection) { share.selection = content; await this.replaceShare(share); }
    this.suppressLocalActivity(abs);
    await fsp.writeFile(abs, nextContent, "utf8");
    await this.recordEvent({ type: "node-updated", shareId: share.id, nodeId, documentId: nodeId ? await this.documentIdForNode(nodeId) : (address.toLowerCase().endsWith(".md") ? (await this.ensureDocument(address)).id : undefined), targetKind: share.target.kind, title: title ?? path.basename(address).replace(/\.md$/i, ""), actor: context.actor, origin: context.actor ? "agent" : "local" }).catch(() => undefined);
    return this.resolveFileShare(share, address, abs, background, title);
  }

  private async readStoredEvents(): Promise<InsightEvent[]> {
    try {
      const events: unknown = JSON.parse(await fsp.readFile(this.p("data", "events.json"), "utf8")) as unknown;
      if (!Array.isArray(events)) return [];
      return events.filter((event: unknown): event is InsightEvent => isRecord(event) && typeof event.at === "string" && typeof event.type === "string");
    } catch { return []; }
  }
  private async readEvents(): Promise<InsightEvent[]> {
    const events = await this.readStoredEvents();
    const shares = new Map((await this.readShares()).map((share) => [share.id, share]));
    return Promise.all(events.map(async (event) => {
        if (event.title || !event.shareId) return event;
        const share = shares.get(event.shareId);
        if (!share) return event;
        if (share.target.kind !== "node") return { ...event, title: path.basename(share.target.path).replace(/\.md$/i, "") };
        try { return { ...event, title: (await this.getNode(share.target.nodeId)).title }; }
        catch { return event; }
      }));
  }
  private async recordEvent(event: Omit<InsightEvent, "at">): Promise<void> {
    const task = this.eventWriteQueue.then(async () => {
      const events = await this.readStoredEvents();
      events.push({ ...event, at: new Date().toISOString() });
      await fsp.writeFile(this.p("data", "events.json"), JSON.stringify(events, null, 2), "utf8");
    });
    this.eventWriteQueue = task.catch(() => undefined);
    await task;
  }
  async getDashboardInsights(now = new Date()): Promise<DashboardInsights> {
    const [nodes, documents, activityEvents] = await Promise.all([this.listNodes(), this.readDocuments(), this.readStoredEvents()]);
    const eventsByDocument = new Map<string, InsightEvent[]>();
    const eventsByNode = new Map<string, InsightEvent[]>();
    for (const event of activityEvents) {
      if (event.documentId) {
        const events = eventsByDocument.get(event.documentId) ?? []; events.push(event); eventsByDocument.set(event.documentId, events);
      }
      if (event.nodeId) {
        const events = eventsByNode.get(event.nodeId) ?? []; events.push(event); eventsByNode.set(event.nodeId, events);
      }
    }
    const weekStart = new Date(now); weekStart.setHours(0, 0, 0, 0); weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const deletionVisibleAfter = new Date(now); deletionVisibleAfter.setDate(deletionVisibleAfter.getDate() - 30);
    const inRange = (at: string, start: Date) => new Date(at) >= start && new Date(at) <= now;
    const resolveEvents = activityEvents.filter((event) => event.type === "share-resolved");
    const activityScore = (items: InsightEvent[]): number => items.reduce((total, event) => total + (ACTIVITY_WEIGHTS[event.type] ?? 0), 0);
    const documentIdForEvent = (event: InsightEvent): string | undefined => event.documentId;
    const recentStart = new Date(now); recentStart.setDate(recentStart.getDate() - 30);
    const buildDocumentContributions = (start?: Date): DocumentContribution[] => documents.filter((document) => !document.deletedAt).map((document) => {
      const documentEvents = (eventsByDocument.get(document.id) ?? []).filter((event) => !start || inRange(event.at, start));
      const categories: Record<ContributionCategory, number> = { construction: 0, reuse: 0, connection: 0, organization: 0 };
      for (const event of documentEvents) categories[contributionCategory(event)] += ACTIVITY_WEIGHTS[event.type] ?? 0;
      return {
        document,
        score: activityScore(documentEvents),
        recentScore: activityScore(documentEvents.filter((event) => inRange(event.at, recentStart))),
        construction: categories.construction,
        reuse: categories.reuse,
        connection: categories.connection,
        organization: categories.organization,
        lastActive: documentEvents.map((event) => event.at).sort().at(-1),
      };
    }).filter((document) => document.score > 0).sort((a, b) => b.score - a.score || (b.lastActive ?? "").localeCompare(a.lastActive ?? ""));
    const documentContributions = buildDocumentContributions();
    const buildRanking = (start: Date, period: "week" | "month" | "all"): InsightNote[] => {
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
        const score = period === "week" ? reads.length * 10 + (updated ? 1 : 0) : distinctWeeks * 1000 + reads.length * 10 + (updated ? 1 : 0);
        const lastRead = reads.map((event) => event.at).sort().at(-1);
        const reason = period === "week" ? `本周被读取 ${reads.length} 次${updated ? "，并在本周更新" : ""}` : period === "month" ? `本月被读取 ${reads.length} 次，跨 ${distinctWeeks} 周复用` : `累计被读取 ${reads.length} 次，跨 ${distinctWeeks} 周复用`;
        return { node, reads: reads.length, lastRead, score, reason };
      }).sort((a, b) => b.score - a.score || (b.lastRead ?? "").localeCompare(a.lastRead ?? "")).slice(0, 3);
    };
    const usedNodeIds = new Set(activityEvents.filter((event) => ["share-resolved", "local-read"].includes(event.type) && inRange(event.at, weekStart)).map(documentIdForEvent).filter(Boolean));
    const dateKey = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const documentsByPath = new Map(documents.map((document) => [document.path, document]));
    const archiveCandidate = (document: VaultDocument, node: AgentNode | undefined, events: InsightEvent[]): ArchiveCandidate | null => {
      if (document.protected || node?.pinned || node?.archived) return null;
      const observed = events.filter((event) => new Date(event.at) <= now);
      const uses = observed.filter((event) => ["share-resolved", "local-read", "document-linked"].includes(event.type));
      const meaningful = observed.filter((event) => ["node-created", "node-updated", "local-created", "local-edited", "share-created", "share-resolved", "local-read", "document-linked"].includes(event.type));
      const lastAttention = Math.max(new Date(document.created).getTime(), new Date(document.updated).getTime(), node ? new Date(node.updated).getTime() : 0, ...meaningful.map((event) => new Date(event.at).getTime()));
      const lastUsed = uses.map((event) => event.at).sort().at(-1);
      const useWeeks = new Set(uses.map((event) => {
        const date = new Date(event.at); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); return dateKey(date);
      })).size;
      const quietDays = uses.length === 0 ? 7 : useWeeks >= 2 ? 90 : 30;
      if (!Number.isFinite(lastAttention) || now.getTime() - lastAttention < quietDays * 86_400_000) return null;
      const reason = uses.length === 0 ? "至少 7 天未被阅读、引用或通过分享链接访问" : useWeeks >= 2 ? "曾跨周复用，近 90 天没有新的使用或维护" : "曾被使用，近 30 天没有新的使用或维护";
      return { document, node, reason, uses: uses.length, lastUsed };
    };
    const nodeCandidates = nodes.flatMap((node): ArchiveCandidate[] => {
      if (node.archived || node.pinned) return [];
      const nodePath = this.idToPath.get(node.id);
      if (!nodePath) return [];
      const relativePath = path.relative(this.root, nodePath).split(path.sep).join("/");
      const document = documentsByPath.get(relativePath) ?? { id: node.id, path: relativePath, title: node.title, created: node.created, updated: node.updated };
      const events = [...new Set([...(eventsByNode.get(node.id) ?? []), ...(eventsByDocument.get(document.id) ?? [])])];
      const candidate = archiveCandidate(document, node, events);
      return candidate ? [candidate] : [];
    });
    const localCandidates = documents.flatMap((document): ArchiveCandidate[] => {
      if (document.deletedAt || document.path.startsWith("agentNote/") || document.path.startsWith(".obsidian/") || !fs.existsSync(path.join(this.root, document.path))) return [];
      const candidate = archiveCandidate(document, undefined, eventsByDocument.get(document.id) ?? []);
      return candidate ? [candidate] : [];
    });
    const archiveCandidates = [...nodeCandidates, ...localCandidates].sort((first, second) => first.uses - second.uses || first.document.updated.localeCompare(second.document.updated));
    const dailyScores = new Map<string, number>();
    for (const event of activityEvents) {
      const date = new Date(event.at);
      if (Number.isNaN(date.getTime())) continue;
      const key = dateKey(date);
      dailyScores.set(key, (dailyScores.get(key) ?? 0) + (ACTIVITY_WEIGHTS[event.type] ?? 0));
    }
    const trend = (start: Date, days: number, label: (date: Date) => string): InsightTrendPoint[] => Array.from({ length: days }, (_, index) => {
      const from = new Date(start); from.setDate(from.getDate() + index);
      return { label: label(from), count: dailyScores.get(dateKey(from)) ?? 0 };
    });
    const recordedAt = [...activityEvents.map((event) => event.at), ...documents.map((document) => document.created)].map((at) => new Date(at).getTime()).filter(Number.isFinite);
    const startedAt = new Date(recordedAt.length ? Math.min(...recordedAt) : now.getTime());
    const contributionStart = new Date(now); contributionStart.setHours(0, 0, 0, 0);
    contributionStart.setDate(contributionStart.getDate() - contributionStart.getDay() - 39 * 7);
    const contributionDays = 39 * 7 + now.getDay() + 1;
    const monthDays = Math.max(1, Math.ceil((now.getTime() - monthStart.getTime()) / 86_400_000) + 1);
    return {
      summary: {
        weekActivityScore: activityScore(activityEvents.filter((event) => inRange(event.at, weekStart))),
        allTimeActivityScore: activityScore(activityEvents),
        weekActivityCount: activityEvents.filter((event) => inRange(event.at, weekStart) && ACTIVITY_WEIGHTS[event.type] !== undefined).length,
        weekCreated: activityEvents.filter((event) => ["node-created", "local-created"].includes(event.type) && inRange(event.at, weekStart)).length,
        weekUpdated: activityEvents.filter((event) => ["node-updated", "local-edited", "local-moved", "local-deleted", "node-archived", "node-restored"].includes(event.type) && inRange(event.at, weekStart)).length,
        weekSharesCreated: activityEvents.filter((event) => event.type === "share-created" && inRange(event.at, weekStart)).length,
        weekResolves: activityEvents.filter((event) => ["share-resolved", "local-read"].includes(event.type) && inRange(event.at, weekStart)).length,
        weekUsedNotes: usedNodeIds.size,
        monthResolves: activityEvents.filter((event) => ["share-resolved", "local-read"].includes(event.type) && inRange(event.at, monthStart)).length,
      },
      weekly: buildRanking(weekStart, "week"),
      weeklyDocuments: buildDocumentContributions(weekStart),
      monthly: buildRanking(monthStart, "month"),
      allTime: buildRanking(startedAt, "all"),
      activities: activityEvents.filter((event) => inRange(event.at, weekStart)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10),
      timeline: activityEvents.filter((event) => event.type !== "local-deleted" || new Date(event.at) >= deletionVisibleAfter).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100),
      weeklyTrend: trend(weekStart, 7, (date) => ["日", "一", "二", "三", "四", "五", "六"][date.getDay()]),
      monthlyTrend: trend(monthStart, monthDays, (date) => String(date.getDate())),
      allTimeTrend: trend(contributionStart, contributionDays, dateKey),
      documents: documentContributions,
      startedAt: startedAt.toISOString(),
      archiveCandidates,
      protectedDocuments: documents.filter((document) => document.protected && !document.deletedAt),
      protectedNodes: nodes.filter((node) => node.pinned && !node.archived),
    };
  }
  async listActivity(filter: { from?: string; to?: string; agent?: string; action?: InsightEventType; nodeId?: string; documentId?: string } = {}): Promise<InsightEvent[]> {
    return (await this.readEvents()).filter((event) => (!filter.from || event.at >= filter.from) && (!filter.to || event.at <= filter.to) && (!filter.agent || (event.actor?.name ?? event.actor?.id) === filter.agent) && (!filter.action || event.type === filter.action) && (!filter.nodeId || event.nodeId === filter.nodeId) && (!filter.documentId || event.documentId === filter.documentId)).sort((a, b) => b.at.localeCompare(a.at));
  }
  async getAgentInsights(): Promise<AgentInsight[]> {
    const grouped = new Map<string, AgentInsight>();
    for (const event of await this.readStoredEvents()) {
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
    for (const event of (await this.readStoredEvents()).filter((event) => event.type === "share-resolved")) {
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
