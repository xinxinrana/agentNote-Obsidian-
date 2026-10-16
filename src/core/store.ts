import { selectionMetadata, type SelectionMetadata } from "./selection";
import { t } from "../i18n";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createHash, randomBytes, randomUUID } from "crypto";
import { isNodeFile, parseNode, serializeNode } from "./nodeFile";
import { AgentNode, NodeSource, NodeType, Share, ShareTarget, normalizeTags, qualityWarnings, shareTarget } from "./types";
import { ActivityLog, ActivityLogOptions } from "./activityLog";
import { inspectData, repairData, validDocuments, type DataRepairResult } from "./dataRepair";

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

export type InsightEventType = "node-created" | "node-updated" | "node-archived" | "node-restored" | "share-created" | "share-resolved" | "local-created" | "local-edited" | "local-read" | "local-moved" | "local-deleted" | "document-linked" | "document-protection";
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
  eventId?: string;
  deviceId?: string;
  storageVersion?: number;
  stateOnly?: boolean;
  previousPath?: string;
  protected?: boolean;
  resolvesProtectionConflict?: boolean;
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
  activityCount: number;
  recentActivityCount: number;
  /** Deprecated API aliases; these now contain unweighted counts. */
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
  health: { complete: boolean; issues: string[]; documentsAvailable: boolean };
  summary: {
    /** Deprecated API aliases; these now contain unweighted counts. */
    weekActivityScore: number;
    allTimeActivityScore: number;
    weekActivityCount: number;
    allTimeActivityCount: number;
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

export type ShareResult = (
  | { shareId: string; kind: "text"; title: string; background: string; content: string; updated: string; filePath: string; hint: string }
  | { shareId: string; kind: "file"; title: string; background: string; address: string; content: string; updated: string; filePath: string; hint: string }
  | { shareId: string; kind: "folder"; title: string; background: string; address: string; entries: string[]; updated: string; filePath: string; hint: string }) & { selection?: SelectionMetadata };

/** Tells the receiving agent how to update the explicitly shared content. */
const SHARE_HINT = "优先通过本链接读取。更新已分享内容时，PATCH /api/shares/<shareId>，请求体为 { content: 更新后的完整内容 }。";
/** Each recorded action counts once. State-only sync events are excluded separately. */
const COUNTED_ACTIVITIES = new Set<InsightEventType>([
  "node-created", "node-updated", "node-archived", "node-restored", "share-created", "share-resolved",
  "local-created", "local-edited", "local-read", "local-moved", "local-deleted", "document-linked", "document-protection",
]);

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
  private readonly configDir: string;
  private readonly referencesFile: string;
  private cache = new Map<string, { mtimeMs: number; node: AgentNode }>();
  private idToPath = new Map<string, string>();
  private idempotentCreates = new Map<string, Promise<{ node: AgentNode; created: boolean }>>();
  private readonly activityLog: ActivityLog;
  private documentWriteQueue: Promise<void> = Promise.resolve();
  private referenceWriteQueue: Promise<void> = Promise.resolve();
  private suppressedLocalPaths = new Map<string, number>();
  private reportedShareErrors = new Set<string>();
  private documentIds = new Map<string, string>();
  private documentIdsLoaded = false;
  private historyWriteIssue: string | null = null;
  private referenceIssue: string | null = null;

  constructor(vaultRoot: string, configDir: string, activityOptions: ActivityLogOptions = {}) {
    this.root = path.resolve(vaultRoot);
    this.dataDir = path.join(this.root, "agentNote");
    this.configDir = this.normalizeVaultPath(configDir);
    this.activityLog = new ActivityLog(this.p("data"), activityOptions);
    this.referencesFile = activityOptions.referencesFile ?? path.join(os.homedir(), ".agentnote", `references.${createHash("sha256").update(this.root).digest("hex").slice(0, 16)}.json`);
  }
  private p(...parts: string[]): string { return path.join(this.dataDir, ...parts); }
  private isConfigPath(filePath: string): boolean {
    const normalized = this.normalizeVaultPath(filePath);
    return normalized === this.configDir || normalized.startsWith(`${this.configDir}/`);
  }

  async init(): Promise<void> {
    await Promise.all([fsp.mkdir(this.p("nodes"), { recursive: true }), fsp.mkdir(this.p("data", "shares"), { recursive: true })]);
    await this.activityLog.init();
  }

  async backupPastDays(now = new Date()): Promise<{ created: number; existing: number }> {
    return this.activityLog.backupPastDays(now);
  }
  inspectData() { return inspectData(this.p("data")); }
  repairData(): Promise<DataRepairResult> {
    const pendingReferences = this.referenceWriteQueue;
    const task = this.documentWriteQueue.then(() => pendingReferences).then(() => repairData(this.p("data")));
    this.documentWriteQueue = task.then(() => undefined, () => undefined);
    this.referenceWriteQueue = this.documentWriteQueue;
    return task;
  }

  private normalizeVaultPath(filePath: string): string {
    const absolute = path.resolve(this.root, filePath);
    if (absolute !== this.root && !absolute.startsWith(`${this.root}${path.sep}`)) throw new StoreError(400, t("文件路径不在当前 vault 中"));
    return path.relative(this.root, absolute).split(path.sep).join("/");
  }
  private documentTitle(filePath: string): string { return path.basename(filePath, ".md") || t("未命名文档"); }
  private async readDataFile<T>(name: string, valid: (value: unknown) => value is T, missing?: T): Promise<T> {
    let raw: string;
    try { raw = await fsp.readFile(this.p("data", name), "utf8"); }
    catch (error) {
      if (missing !== undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return missing;
      throw new StoreError(409, t("{0} 无法读取，请检查并解决 Git 冲突后重试", name));
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (valid(value)) return value;
    } catch { /* Leave the file untouched for recovery. */ }
    throw new StoreError(409, t("{0} 内容损坏，请检查并解决 Git 冲突后重试", name));
  }
  private async readDocuments(): Promise<VaultDocument[]> {
    return this.readDataFile("documents.json", validDocuments, []);
  }
  private async documentView(events: InsightEvent[], nodes: AgentNode[] = []): Promise<{ documents: VaultDocument[]; issue?: string; protectionConflicts: Set<string> }> {
    let legacy: VaultDocument[] = [];
    let issue: string | undefined;
    try { legacy = await this.readDocuments(); }
    catch (error) { issue = error instanceof Error ? error.message : String(error); }
    const legacyIds = new Set(legacy.map((document) => document.id));
    const documents = new Map(legacy.map((document) => [document.id, { ...document }]));
    const idsByPath = new Map(legacy.map((document) => [document.path, document.id]));
    const protectionChoices = new Map<string, { value: boolean; deviceId?: string }>();
    const protectionConflicts = new Set<string>();
    const nodePaths = new Map(nodes.flatMap((node) => {
      const absolute = this.idToPath.get(node.id);
      return absolute ? [[node.id, path.relative(this.root, absolute).split(path.sep).join("/")] as const] : [];
    }));
    for (const event of events) {
      const eventPath = event.path ?? (event.nodeId ? nodePaths.get(event.nodeId) : undefined);
      if (!eventPath) continue;
      const documentId = event.documentId ?? (event.previousPath ? idsByPath.get(event.previousPath) : undefined) ?? idsByPath.get(eventPath);
      if (!documentId) continue;
      const previous = documents.get(documentId);
      if (!previous) documents.set(documentId, { id: documentId, path: eventPath, title: event.title ?? this.documentTitle(eventPath), created: event.at, updated: event.at });
      const document = documents.get(documentId)!;
      if (legacyIds.has(documentId) && event.storageVersion !== 2) continue;
      if (event.type === "local-moved" && event.previousPath) idsByPath.delete(event.previousPath);
      if (["local-moved", "local-created", "local-edited", "local-read", "node-created", "node-updated", "node-archived", "node-restored"].includes(event.type)) {
        if (document.path !== eventPath) idsByPath.delete(document.path);
        document.path = eventPath;
        document.title = event.title ?? this.documentTitle(eventPath);
        delete document.deletedAt;
      }
      if (event.type === "local-deleted") document.deletedAt = event.at;
      if (event.type === "document-protection" && event.protected !== undefined) {
        const previousChoice = protectionChoices.get(documentId);
        if (event.resolvesProtectionConflict) protectionConflicts.delete(documentId);
        else if (previousChoice && previousChoice.value !== event.protected && previousChoice.deviceId !== event.deviceId) protectionConflicts.add(documentId);
        protectionChoices.set(documentId, { value: event.protected, deviceId: event.deviceId });
        document.protected = protectionConflicts.has(documentId) || event.protected;
      }
      if (["local-created", "local-edited", "local-moved", "local-deleted", "node-created", "node-updated", "node-archived", "node-restored"].includes(event.type)) document.updated = event.at;
      idsByPath.set(document.path, documentId);
    }
    this.documentIds = idsByPath;
    this.documentIdsLoaded = true;
    if (protectionConflicts.size) issue = [issue, t("{0} 份资料的保护状态存在跨设备分歧，整理建议已暂停", protectionConflicts.size)].filter(Boolean).join("；");
    return { documents: [...documents.values()], issue, protectionConflicts };
  }
  private async documentIdForPath(filePath: string): Promise<string> {
    const normalized = this.normalizeVaultPath(filePath);
    let documentId = this.documentIds.get(normalized);
    if (!documentId && !this.documentIdsLoaded) {
      await this.documentView(await this.readStoredEvents());
      documentId = this.documentIds.get(normalized);
    }
    if (!documentId) documentId = `d-${createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
    this.documentIds.set(normalized, documentId);
    return documentId;
  }
  async protectDocument(documentId: string, protectedValue: boolean): Promise<void> {
    const { documents, protectionConflicts } = await this.documentView(await this.readStoredEvents());
    const document = documents.find((candidate) => candidate.id === documentId && !candidate.deletedAt);
    if (!document) throw new StoreError(404, t("文档不存在"));
    await this.recordEvent({ type: "document-protection", documentId, path: document.path, title: document.title, protected: protectedValue, resolvesProtectionConflict: protectionConflicts.has(documentId), stateOnly: true, storageVersion: 2 });
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
  async recordLocalActivity(type: Extract<InsightEventType, `local-${string}`>, filePath: string, oldPath?: string, recordHistory = true): Promise<boolean> {
    if (!filePath.toLowerCase().endsWith(".md") || this.isConfigPath(filePath)) return false;
    if (type !== "local-moved" && this.consumeSuppressedLocalActivity(filePath)) return false;
    const normalized = this.normalizeVaultPath(filePath);
    const previousPath = oldPath ? this.normalizeVaultPath(oldPath) : undefined;
    const documentId = await this.documentIdForPath(previousPath ?? normalized);
    if (recordHistory || type === "local-moved") await this.recordEvent({ type, documentId, path: normalized, previousPath, title: this.documentTitle(normalized), origin: "local", stateOnly: !recordHistory, storageVersion: 2 });
    if (previousPath) { this.documentIds.delete(previousPath); this.documentIds.set(normalized, documentId); }
    if (type === "local-moved" && oldPath) {
      await this.moveReferenceSource(oldPath, filePath).catch((error) => { this.referenceIssue = error instanceof Error ? error.message : String(error); });
      await this.moveShareTargets(oldPath, filePath);
    }
    return true;
  }
  private async moveShareTargets(oldPath: string, newPath: string): Promise<void> {
    const oldNormalized = this.normalizeVaultPath(oldPath);
    const newNormalized = this.normalizeVaultPath(newPath);
    for (const share of await this.readShares()) {
      if (share.target.kind !== "file" || this.normalizeVaultPath(share.target.path) !== oldNormalized) continue;
      share.target.path = newNormalized;
      await this.writeShare(share);
    }
  }
  private async readReferences(): Promise<Record<string, string[]>> {
    let raw: string;
    try { raw = await fsp.readFile(this.referencesFile, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {};
    }
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !Object.values(value).every((targets) => Array.isArray(targets) && targets.every((target) => typeof target === "string"))) throw new Error(t("本机引用索引格式无效"));
    return value as Record<string, string[]>;
  }
  private async writeReferences(references: Record<string, string[]>): Promise<void> {
    await fsp.mkdir(path.dirname(this.referencesFile), { recursive: true });
    const temporary = `${this.referencesFile}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temporary, JSON.stringify(references, null, 2), { flag: "wx" });
      await fsp.rename(temporary, this.referencesFile);
    } finally { await fsp.rm(temporary, { force: true }); }
  }
  async recordDocumentReferences(sourcePath: string, targetPaths: string[], recordAdditions = true): Promise<void> {
    const source = this.normalizeVaultPath(sourcePath);
    const targets = [...new Set(targetPaths.filter((target) => target.toLowerCase().endsWith(".md")).map((target) => this.normalizeVaultPath(target)).filter((target) => target !== source))].sort();
    const task = this.referenceWriteQueue.then(async () => {
      const references = await this.readReferences();
      const hasBaseline = Object.hasOwn(references, source);
      const previous = new Set(references[source] ?? []);
      if (hasBaseline && targets.length === previous.size && targets.every((target) => previous.has(target))) return;
      references[source] = targets;
      await this.writeReferences(references);
      if (!recordAdditions || !hasBaseline) return;
      for (const target of targets.filter((candidate) => !previous.has(candidate))) {
        await this.recordEvent({ type: "document-linked", documentId: await this.documentIdForPath(target), path: target, sourcePath: source, title: this.documentTitle(target), origin: "local", storageVersion: 2 });
      }
    });
    this.referenceWriteQueue = task.catch((error) => { this.referenceIssue = error instanceof Error ? error.message : String(error); });
    await task;
    this.referenceIssue = null;
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
      if (changed) await this.writeReferences(references);
    });
    this.referenceWriteQueue = task.catch((error) => { this.referenceIssue = error instanceof Error ? error.message : String(error); });
    await task;
    this.referenceIssue = null;
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
    if (!node) throw new StoreError(404, t("笔记不存在: {0}", id));
    return node;
  }
  async nodeFilePath(id: string): Promise<string> {
    await this.scanNodes();
    const file = this.idToPath.get(id);
    if (!file) throw new StoreError(404, t("笔记不存在: {0}", id));
    return path.relative(this.root, file).split(path.sep).join("/");
  }
  private async nodeFileAbsPath(id: string): Promise<string> {
    await this.scanNodes();
    const file = this.idToPath.get(id);
    if (!file) throw new StoreError(404, t("笔记不存在: {0}", id));
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
    const previousRelative = previous ? path.relative(this.root, previous).split(path.sep).join("/") : undefined;
    const previousDocumentId = previous && previous !== destination ? await this.documentIdForPath(previousRelative!) : undefined;
    this.suppressLocalActivity(destination);
    if (previous && previous !== destination) this.suppressLocalActivity(previous);
    await fsp.writeFile(destination, serializeNode(node), "utf8");
    if (previous && previous !== destination) {
      await fsp.rm(previous, { force: true });
      await this.moveReferenceSource(path.relative(this.root, previous), path.relative(this.root, destination));
    }
    const stat = await fsp.stat(destination);
    this.cache.set(destination, { mtimeMs: stat.mtimeMs, node: { ...node, updated: stat.mtime.toISOString() } });
    this.idToPath.set(node.id, destination);
    if (previousRelative && previousDocumentId && previous !== destination) {
      this.documentIds.delete(previousRelative);
      this.documentIds.set(path.relative(this.root, destination).split(path.sep).join("/"), previousDocumentId);
    }
  }
  private async documentIdForNode(nodeId: string): Promise<string | undefined> {
    try { return await this.documentIdForPath(await this.nodeFilePath(nodeId)); }
    catch { return undefined; }
  }
  private async documentIdForTarget(target: ShareTarget): Promise<string | undefined> {
    if (target.kind === "node") return this.documentIdForNode(target.nodeId);
    if (target.kind === "file" && target.path.toLowerCase().endsWith(".md")) return this.documentIdForPath(target.path);
    return undefined;
  }
  private async documentPathForTarget(target: ShareTarget): Promise<string | undefined> {
    if (target.kind === "node") return this.nodeFilePath(target.nodeId).catch(() => undefined);
    return target.kind === "file" && target.path.toLowerCase().endsWith(".md") ? this.normalizeVaultPath(target.path) : undefined;
  }

  private async readIdempotencyKeys(): Promise<Record<string, string>> {
    return this.readDataFile("idempotency.json", (value): value is Record<string, string> => isRecord(value) && Object.values(value).every((item) => typeof item === "string"), {});
  }
  private idempotencyFile(key: string): string {
    return this.p("data", "idempotency", `${createHash("sha256").update(key).digest("hex")}.json`);
  }
  private async readIdempotencyKey(key: string): Promise<string | undefined> {
    const file = this.idempotencyFile(key);
    let raw: string;
    try { raw = await fsp.readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return (await this.readIdempotencyKeys())[key];
    }
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new StoreError(409, t("幂等记录内容损坏，请检查并解决 Git 冲突后重试")); }
    if (isRecord(value) && value.key === key && typeof value.nodeId === "string") return value.nodeId;
    throw new StoreError(409, t("幂等记录内容损坏，请检查并解决 Git 冲突后重试"));
  }
  private async writeIdempotencyKey(key: string, nodeId: string): Promise<void> {
    const file = this.idempotencyFile(key);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temporary, JSON.stringify({ key, nodeId }, null, 2), { flag: "wx" });
      try { await fsp.link(temporary, file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.readIdempotencyKey(key) !== nodeId) throw new StoreError(409, t("幂等键已关联另一份笔记"));
      }
    } finally { await fsp.rm(temporary, { force: true }); }
  }

  async createNode(input: CreateNodeInput, idempotencyKey?: string, context: ActivityContext = {}): Promise<AgentNode> {
    return (await this.createNodeResult(input, idempotencyKey, context)).node;
  }
  async createNodeResult(input: CreateNodeInput, idempotencyKey?: string, context: ActivityContext = {}): Promise<{ node: AgentNode; created: boolean }> {
    if (!input.title?.trim()) throw new StoreError(400, t("标题不能为空"));
    const key = idempotencyKey?.trim();
    if (key) {
      const active = this.idempotentCreates.get(key);
      if (active) return { node: (await active).node, created: false };
      const operation = this.createNodeWithKey(input, key, context);
      this.idempotentCreates.set(key, operation);
      try { return await operation; } finally { this.idempotentCreates.delete(key); }
    }
    return this.createNodeWithKey(input, undefined, context);
  }
  private async createNodeWithKey(input: CreateNodeInput, idempotencyKey?: string, context: ActivityContext = {}): Promise<{ node: AgentNode; created: boolean }> {
    if (idempotencyKey) {
      const existingId = await this.readIdempotencyKey(idempotencyKey);
      if (existingId) {
        try { return { node: await this.getNode(existingId), created: false }; }
        catch (error) { if (!(error instanceof StoreError) || error.statusCode !== 404) throw error; throw new StoreError(409, t("幂等记录关联的笔记不存在，请检查后重试")); }
      }
    }
    const type = input.type ?? "snippet";
    if ((type === "file" || type === "folder") && !input.path?.trim()) throw new StoreError(400, t("{0} 笔记需要文件地址", type));
    const now = new Date().toISOString();
    const node: AgentNode = { id: newId("n"), type, title: input.title.trim(), content: input.content ?? "", background: input.background?.trim() ?? "", tags: normalizeTags(input.tags), source: input.source ?? "agent", path: input.path?.trim() || undefined, created: now, updated: now, archived: false, pinned: false };
    await this.writeNode(node);
    if (idempotencyKey) await this.writeIdempotencyKey(idempotencyKey, node.id);
    await this.recordEvent({ type: "node-created", nodeId: node.id, documentId: await this.documentIdForNode(node.id), path: await this.nodeFilePath(node.id), title: node.title, actor: context.actor, origin: context.actor ? "agent" : "local", storageVersion: 2 }).catch(() => undefined);
    return { node, created: true };
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
    await this.recordEvent({ type: archivedChanged ? (node.archived ? "node-archived" : "node-restored") : "node-updated", nodeId: node.id, documentId: await this.documentIdForNode(node.id), path: await this.nodeFilePath(node.id), title: node.title, actor: context.actor, origin: context.actor ? "agent" : "local", storageVersion: 2 }).catch(() => undefined);
    return node;
  }
  async archiveNode(id: string, archived: boolean, context: ActivityContext = {}): Promise<AgentNode> {
    const node = await this.getNode(id);
    node.archived = archived;
    await this.writeNode(node);
    await this.recordEvent({ type: archived ? "node-archived" : "node-restored", nodeId: node.id, documentId: await this.documentIdForNode(node.id), path: await this.nodeFilePath(node.id), title: node.title, actor: context.actor, origin: context.actor ? "agent" : "local", storageVersion: 2 }).catch(() => undefined);
    return node;
  }
  async archiveNodes(ids: string[], archived: boolean): Promise<AgentNode[]> {
    const changed: AgentNode[] = [];
    for (const id of ids) changed.push(await this.archiveNode(id, archived));
    return changed;
  }

  private validShare(value: unknown): value is Share {
    if (!isRecord(value) || typeof value.id !== "string" || typeof value.created !== "string") return false;
    const target = value.target ?? (typeof value.nodeId === "string" ? { kind: "node", nodeId: value.nodeId } : undefined);
    return isRecord(target) && ((target.kind === "node" && typeof target.nodeId === "string") || ((target.kind === "file" || target.kind === "folder") && typeof target.path === "string")) && (value.selection === undefined || typeof value.selection === "string") && (value.background === undefined || typeof value.background === "string");
  }
  private shareFile(id: string): string {
    if (!/^s-x-[a-zA-Z0-9-]{1,120}$/.test(id)) throw new StoreError(400, t("分享 ID 无效"));
    return this.p("data", "shares", `${id}.json`);
  }
  private async readLegacyShares(): Promise<Share[]> {
    const shares = await this.readDataFile("shares.json", (value): value is Share[] => Array.isArray(value) && value.every((share) => this.validShare(share)), []);
    return shares.map((share) => ({ ...share, target: shareTarget(share) }));
  }
  private async readShareFile(id: string): Promise<Share | null> {
    this.shareFile(id);
    const share = await this.readDataFile<Share | null>(`shares/${id}.json`, (value): value is Share | null => this.validShare(value) && value.id === id, null);
    return share ? { ...share, target: shareTarget(share) } : null;
  }
  private reportDataError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.reportedShareErrors.has(message)) return;
    this.reportedShareErrors.add(message);
    console.warn(t("agentNote: {0}；原文件已保留，其他完好功能仍可使用。", message));
  }
  private async readShares(): Promise<Share[]> {
    let legacy: Share[];
    try { legacy = await this.readLegacyShares(); }
    catch (error) { this.reportDataError(error); legacy = []; }
    const shares = new Map<string, Share>();
    const names = await fsp.readdir(this.p("data", "shares"));
    const shareFiles = names.filter((file) => /^s-x-[a-zA-Z0-9-]{1,120}\.json$/.test(file)).sort();
    const independentIds = new Set(shareFiles.map((file) => file.slice(0, -5)));
    for (const name of shareFiles) {
      try {
        const share = await this.readShareFile(name.slice(0, -5));
        if (share) shares.set(share.id, share);
      } catch (error) { this.reportDataError(error); }
    }
    for (const share of legacy) if (!independentIds.has(share.id)) shares.set(share.id, share);
    return [...shares.values()].sort((first, second) => first.created.localeCompare(second.created) || first.id.localeCompare(second.id));
  }
  private async getShare(id: string): Promise<Share> {
    if (!/^s-x-[a-zA-Z0-9-]{1,120}$/.test(id)) throw new StoreError(404, t("分享不存在: {0}", id));
    const share = await this.readShareFile(id);
    if (share) return share;
    const legacy = (await this.readLegacyShares()).find((candidate) => candidate.id === id);
    if (!legacy) throw new StoreError(404, t("分享不存在: {0}", id));
    return legacy;
  }
  private async writeShare(share: Share, create = false): Promise<void> {
    const file = this.shareFile(share.id);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await fsp.writeFile(temporary, JSON.stringify(share, null, 2), { flag: "wx" });
      if (create) await fsp.link(temporary, file);
      else await fsp.rename(temporary, file);
    } finally { await fsp.rm(temporary, { force: true }); }
  }
  async listShares(): Promise<Share[]> { return this.readShares(); }
  async shareSourcePath(id: string): Promise<string> {
    const share = await this.getShare(id);
    if (share.selection !== undefined) throw new StoreError(400, t("选段分享暂不支持查询双链"));
    if (share.target.kind === "folder") throw new StoreError(400, t("文件夹分享不能查询双链"));
    let sourcePath: string;
    if (share.target.kind === "file") sourcePath = this.vaultPath(share.target.path).rel;
    else {
      const node = await this.getNode(share.target.nodeId);
      if (node.type === "folder") throw new StoreError(400, t("文件夹分享不能查询双链"));
      if (node.type === "snippet") sourcePath = await this.nodeFilePath(node.id);
      else {
        if (!node.path) throw new StoreError(410, t("笔记缺少文件地址"));
        sourcePath = path.relative(this.root, path.resolve(node.path)).split(path.sep).join("/");
        if (sourcePath === ".." || sourcePath.startsWith("../") || path.isAbsolute(sourcePath)) throw new StoreError(400, t("仅支持 vault 内的 Markdown 文件"));
      }
    }
    if (!sourcePath.toLowerCase().endsWith(".md")) throw new StoreError(400, t("仅支持 Markdown 文件的双链查询"));
    return sourcePath;
  }
  async activityFilePath(activity: Pick<InsightEvent, "nodeId" | "documentId" | "shareId" | "path">): Promise<string | null> {
    if (activity.nodeId) return this.nodeFilePath(activity.nodeId).catch(() => null);
    if (activity.documentId) {
      const document = (await this.documentView(await this.readStoredEvents())).documents.find((candidate) => candidate.id === activity.documentId);
      return document ? (document.deletedAt ? null : document.path) : activity.path ?? null;
    }
    if (activity.shareId) {
      const share = (await this.readShares()).find((candidate) => candidate.id === activity.shareId);
      if (!share) return null;
      if (share.target.kind === "node") return this.nodeFilePath(share.target.nodeId).catch(() => null);
      return share.target.kind === "file" ? share.target.path : null;
    }
    return activity.path ?? null;
  }
  private async readRegisteredAgents(): Promise<RegisteredAgent[]> {
    let legacy: RegisteredAgent[] = [];
    try { legacy = await this.readDataFile("agents.json", (value): value is RegisteredAgent[] => Array.isArray(value) && value.every((agent) => isRecord(agent) && typeof agent.id === "string" && typeof agent.name === "string" && !!agent.id.trim() && !!agent.name.trim()), []); }
    catch (error) { this.reportDataError(error); }
    const agents = new Map(legacy.map((agent) => [agent.id, agent]));
    const directory = this.p("data", "agents");
    const files = await fsp.readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    for (const name of files.filter((file) => /^[a-f0-9]{64}\.json$/.test(file))) {
      try {
        const value: unknown = JSON.parse(await fsp.readFile(path.join(directory, name), "utf8"));
        if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || createHash("sha256").update(value.id).digest("hex") !== name.slice(0, -5)) throw new Error(t("Agent 身份记录格式无效"));
        agents.set(value.id, { id: value.id, name: value.name });
      } catch (error) { this.reportDataError(error); }
    }
    return [...agents.values()];
  }
  async registerAgent(agent: RegisteredAgent): Promise<void> {
    const id = agent.id.trim().toLowerCase().slice(0, 80);
    const name = agent.name.trim().slice(0, 80);
    if (!id || !name) throw new StoreError(400, t("agent 身份不完整"));
    const file = this.p("data", "agents", `${createHash("sha256").update(id).digest("hex")}.json`);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temporary, JSON.stringify({ id, name }, null, 2), { flag: "wx" });
      await fsp.rename(temporary, file);
    } finally { await fsp.rm(temporary, { force: true }); }
  }
  async resolveActivityContext(context: ActivityContext): Promise<ActivityContext> {
    const actor = context.actor;
    const id = actor?.id?.trim().toLowerCase();
    if (!actor || !id) return context;
    let registered: RegisteredAgent | undefined;
    try { registered = (await this.readRegisteredAgents()).find((agent) => agent.id === id); }
    catch { return context; }
    return registered ? { actor: { id: registered.id, name: registered.name, sessionTitle: actor.sessionTitle } } : context;
  }
  private async appendShare(target: ShareTarget, selection?: string, background?: string, context: ActivityContext = {}, title?: string, selectionStart?: number, selectionSource?: string): Promise<Share> {
    const share: Share = { id: newId("s-x"), target, selection, selectionStart, selectionSourceHash: selection && selectionSource !== undefined ? this.sourceHash(selectionSource) : undefined, background: background?.trim() || undefined, created: new Date().toISOString() };
    await this.writeShare(share, true);
    const documentId = await this.documentIdForTarget(target).catch(() => undefined);
    await this.recordEvent({ type: "share-created", shareId: share.id, nodeId: target.kind === "node" ? target.nodeId : undefined, documentId, path: await this.documentPathForTarget(target), targetKind: target.kind, title, actor: context.actor, origin: context.actor ? "agent" : "local", storageVersion: 2 }).catch(() => undefined);
    return share;
  }
  async createShare(nodeId: string, selection?: string, context: ActivityContext = {}, selectionStart?: number): Promise<Share> {
    selection = selection || undefined;
    const node = await this.getNode(nodeId);
    if (selection && node.type !== "snippet") throw new StoreError(400, t("只有文本笔记能分享选段"));
    if (selection && !node.content.includes(selection)) throw new StoreError(400, t("选段已不在当前正文中"));
    return this.appendShare({ kind: "node", nodeId }, selection, undefined, context, node.title, selectionStart, node.content);
  }
  /** Every written node gets a whole-note share link; reuse the existing one
   *  so the link returned at write time stays the canonical address. */
  async ensureShareForNode(nodeId: string, context: ActivityContext = {}): Promise<Share> {
    const existing = (await this.readShares()).find((share) => share.target.kind === "node" && share.target.nodeId === nodeId && share.selection === undefined);
    return existing ?? this.createShare(nodeId, undefined, context);
  }
  private vaultPath(relPath: string): { rel: string; abs: string } {
    const rel = relPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!rel || rel.split("/").includes("..")) throw new StoreError(400, t("必须提供 vault 内相对路径"));
    return { rel, abs: path.join(this.root, ...rel.split("/")) };
  }
  async createPathShare(relPath: string, background?: string, selection?: string, context: ActivityContext = {}, selectionStart?: number): Promise<Share> {
    selection = selection || undefined;
    const { rel, abs } = this.vaultPath(relPath);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat) throw new StoreError(404, t("找不到内容: {0}", rel));
    const title = path.basename(rel).replace(/\.md$/i, "");
    if (stat.isDirectory()) { if (selection) throw new StoreError(400, t("文件夹不能分享选段")); return this.appendShare({ kind: "folder", path: rel }, undefined, background, context, title); }
    const source = selection ? await fsp.readFile(abs, "utf8") : undefined;
    if (selection && !source!.includes(selection)) throw new StoreError(400, t("选段已不在当前文件中"));
    return this.appendShare({ kind: "file", path: rel }, selection, background, context, title, selectionStart, source);
  }

  async resolveShare(id: string, context: ActivityContext = {}): Promise<ShareResult> {
    const share = await this.getShare(id);
    let result: ShareResult;
    if (share.target.kind === "node") {
      result = await this.resolveNodeShare(share, await this.getNode(share.target.nodeId));
    } else {
      const target = share.target;
      const { rel, abs } = this.vaultPath(target.path);
      result = target.kind === "file" ? await this.resolveFileShare(share, rel, abs) : await this.resolveFolderShare(share, rel, abs);
    }
    const documentId = await this.documentIdForTarget(share.target).catch(() => undefined);
    await this.recordEvent({ type: "share-resolved", shareId: share.id, nodeId: share.target.kind === "node" ? share.target.nodeId : undefined, documentId, path: await this.documentPathForTarget(share.target), targetKind: share.target.kind, title: result.title, actor: context.actor, origin: context.actor ? "agent" : "link", storageVersion: 2 }).catch(() => undefined);
    return result;
  }

  async updateShareContent(id: string, content: string, context: ActivityContext = {}): Promise<ShareResult> {
    const share = await this.getShare(id);
    if (share.target.kind === "folder") throw new StoreError(400, t("文件夹分享不支持通过接口直接修改"));

    if (share.target.kind === "node") {
      const node = await this.getNode(share.target.nodeId);
      if (node.type === "snippet") {
        const nextContent = share.selection !== undefined ? this.replaceSelection(node.content, share, content) : content;
        if (share.selection !== undefined) { share.selection = content; await this.replaceShare(share); }
        return this.resolveNodeShare(share, await this.updateNode(node.id, { content: nextContent }, context));
      }
      if (!node.path) throw new StoreError(410, t("笔记缺少文件地址"));
      return this.updateSharedFile(share, node.path, node.path, content, context, node.id, node.background, node.title);
    }

    const { rel, abs } = this.vaultPath(share.target.path);
    return this.updateSharedFile(share, rel, abs, content, context);
  }

  private replaceSelection(current: string, share: Share, replacement: string): string {
    const selection = share.selection!;
    if (!current.includes(selection)) throw new StoreError(410, t("分享选段已不在当前文件中"));
    const position = selectionMetadata(current, selection, this.selectionOffset(share, current)).position;
    if (position.status !== "exact") throw new StoreError(409, t("选段存在多处匹配，请重新选择并分享后再修改"));
    share.selectionStart = position.startOffset;
    const next = current.slice(0, position.startOffset) + replacement + current.slice(position.endOffset);
    share.selectionSourceHash = this.sourceHash(next);
    return next;
  }

  private async replaceShare(share: Share): Promise<void> {
    await this.writeShare(share);
  }

  private async updateSharedFile(share: Share, address: string, abs: string, content: string, context: ActivityContext, nodeId?: string, background?: string, title?: string): Promise<ShareResult> {
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw new StoreError(400, t("只有文本文件分享支持通过接口直接修改"));
    const current = await fsp.readFile(abs, "utf8");
    const nextContent = share.selection !== undefined ? this.replaceSelection(current, share, content) : content;
    if (share.selection !== undefined) { share.selection = content; await this.replaceShare(share); }
    this.suppressLocalActivity(abs);
    await fsp.writeFile(abs, nextContent, "utf8");
    const documentId = await this.documentIdForTarget(share.target).catch(() => undefined);
    await this.recordEvent({ type: "node-updated", shareId: share.id, nodeId, documentId, targetKind: share.target.kind, title: title ?? path.basename(address).replace(/\.md$/i, ""), actor: context.actor, origin: context.actor ? "agent" : "local" }).catch(() => undefined);
    return this.resolveFileShare(share, address, abs, background, title);
  }

  private async readStoredEvents(): Promise<InsightEvent[]> {
    return this.activityLog.read();
  }
  private async readEvents(): Promise<InsightEvent[]> {
    const events = (await this.readStoredEvents()).filter((event) => !event.stateOnly);
    if (!events.some((event) => !event.title && event.shareId)) return events;
    const shares = new Map((await this.readShares().catch(() => [] as Share[])).map((share) => [share.id, share]));
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
    try { await this.activityLog.append(event); this.historyWriteIssue = null; }
    catch (error) {
      this.historyWriteIssue = error instanceof Error ? error.message : String(error);
      console.warn(t("agentNote: 本次活动未记录：{0}", this.historyWriteIssue));
      throw error;
    }
  }
  async getDashboardInsights(now = new Date()): Promise<DashboardInsights> {
    const [nodes, activityReport] = await Promise.all([this.listNodes(), this.activityLog.readReport()]);
    const documentReport = await this.documentView(activityReport.events, nodes);
    const documents = documentReport.documents;
    const activityEvents = activityReport.events.filter((event) => !event.stateOnly);
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
    const activityCount = (items: InsightEvent[]): number => items.filter((event) => COUNTED_ACTIVITIES.has(event.type)).length;
    const documentIdForEvent = (event: InsightEvent): string | undefined => event.documentId;
    const recentStart = new Date(now); recentStart.setDate(recentStart.getDate() - 30);
    const buildDocumentContributions = (start?: Date): DocumentContribution[] => documents.filter((document) => !document.deletedAt).map((document) => {
      const documentEvents = (eventsByDocument.get(document.id) ?? []).filter((event) => !start || inRange(event.at, start));
      const categories: Record<ContributionCategory, number> = { construction: 0, reuse: 0, connection: 0, organization: 0 };
      for (const event of documentEvents) if (COUNTED_ACTIVITIES.has(event.type)) categories[contributionCategory(event)]++;
      return {
        document,
        activityCount: activityCount(documentEvents),
        recentActivityCount: activityCount(documentEvents.filter((event) => inRange(event.at, recentStart))),
        score: activityCount(documentEvents),
        recentScore: activityCount(documentEvents.filter((event) => inRange(event.at, recentStart))),
        construction: categories.construction,
        reuse: categories.reuse,
        connection: categories.connection,
        organization: categories.organization,
        lastActive: documentEvents.map((event) => event.at).sort().at(-1),
      };
    }).filter((document) => document.activityCount > 0).sort((a, b) => b.activityCount - a.activityCount || (b.lastActive ?? "").localeCompare(a.lastActive ?? ""));
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
        const score = reads.length;
        const lastRead = reads.map((event) => event.at).sort().at(-1);
        const reason = period === "week" ? t("本周被读取 {0} 次{1}", reads.length, updated ? t("，并在本周更新") : "") : period === "month" ? t("本月被读取 {0} 次，跨 {1} 周复用", reads.length, distinctWeeks) : t("累计被读取 {0} 次，跨 {1} 周复用", reads.length, distinctWeeks);
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
      const reason = uses.length === 0 ? t("至少 7 天未被阅读、引用或通过分享链接访问") : useWeeks >= 2 ? t("曾跨周复用，近 90 天没有新的使用或维护") : t("曾被使用，近 30 天没有新的使用或维护");
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
      if (document.deletedAt || document.path.startsWith("agentNote/") || this.isConfigPath(document.path) || !fs.existsSync(path.join(this.root, document.path))) return [];
      const candidate = archiveCandidate(document, undefined, eventsByDocument.get(document.id) ?? []);
      return candidate ? [candidate] : [];
    });
    const archiveCandidates = activityReport.issues.length || documentReport.issue ? [] : [...nodeCandidates, ...localCandidates].sort((first, second) => first.uses - second.uses || first.document.updated.localeCompare(second.document.updated));
    const dailyCounts = new Map<string, number>();
    for (const event of activityEvents) {
      const date = new Date(event.at);
      if (Number.isNaN(date.getTime())) continue;
      const key = dateKey(date);
      dailyCounts.set(key, (dailyCounts.get(key) ?? 0) + (COUNTED_ACTIVITIES.has(event.type) ? 1 : 0));
    }
    const trend = (start: Date, days: number, label: (date: Date) => string): InsightTrendPoint[] => Array.from({ length: days }, (_, index) => {
      const from = new Date(start); from.setDate(from.getDate() + index);
      return { label: label(from), count: dailyCounts.get(dateKey(from)) ?? 0 };
    });
    const recordedAt = [...activityEvents.map((event) => event.at), ...documents.map((document) => document.created)].map((at) => new Date(at).getTime()).filter(Number.isFinite);
    const startedAt = new Date(recordedAt.length ? Math.min(...recordedAt) : now.getTime());
    const contributionStart = new Date(now); contributionStart.setHours(0, 0, 0, 0);
    contributionStart.setDate(contributionStart.getDate() - contributionStart.getDay() - 39 * 7);
    const contributionDays = 39 * 7 + now.getDay() + 1;
    const monthDays = Math.max(1, Math.ceil((now.getTime() - monthStart.getTime()) / 86_400_000) + 1);
    return {
      health: { complete: activityReport.issues.length === 0 && !documentReport.issue && !this.historyWriteIssue && !this.referenceIssue, issues: [...activityReport.issues.map((issue) => `${issue.file}: ${issue.message}`), ...(documentReport.issue ? [documentReport.issue] : []), ...(this.historyWriteIssue ? [t("本次活动未记录：{0}", this.historyWriteIssue)] : []), ...(this.referenceIssue ? [t("本机引用索引暂时不可用：{0}", this.referenceIssue)] : [])], documentsAvailable: !documentReport.issue },
      summary: {
        weekActivityScore: activityCount(activityEvents.filter((event) => inRange(event.at, weekStart))),
        allTimeActivityScore: activityCount(activityEvents),
        allTimeActivityCount: activityCount(activityEvents),
        weekActivityCount: activityEvents.filter((event) => inRange(event.at, weekStart) && COUNTED_ACTIVITIES.has(event.type)).length,
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
      activities: [...activityEvents].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10),
      timeline: activityEvents.filter((event) => event.type !== "local-deleted" || new Date(event.at) >= deletionVisibleAfter).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100),
      weeklyTrend: trend(weekStart, 7, (date) => [t("日"), t("一"), t("二"), t("三"), t("四"), t("五"), t("六")][date.getDay()]),
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
      const name = event.actor.name ?? event.actor.id ?? t("未申报 agent");
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
      const row = grouped.get(key) ?? { nodeId: event.nodeId, title: event.title ?? t("未命名资料"), uses: 0, agents: [], lastUsed: event.at };
      row.uses++;
      const actorName = event.actor?.name ?? event.actor?.id;
      if (actorName && !row.agents.includes(actorName)) row.agents.push(actorName);
      if (event.at > row.lastUsed) row.lastUsed = event.at;
      grouped.set(key, row);
    }
    return [...grouped.values()].sort((a, b) => b.uses - a.uses || b.lastUsed.localeCompare(a.lastUsed));
  }
  private sourceHash(source: string): string { return createHash("sha256").update(source).digest("hex"); }
  private selectionOffset(share: Share, source: string): number | undefined {
    return share.selectionSourceHash === this.sourceHash(source) ? share.selectionStart : undefined;
  }
  private selectionDetails(share: Share, source: string): { hint: string; selection?: SelectionMetadata } {
    if (share.selection === undefined) return { hint: t(SHARE_HINT) };
    return { selection: selectionMetadata(source, share.selection, this.selectionOffset(share, source)), hint: t("这是用户选中的节选，不应将其视为原文全文或据此推断完整观点。位置与占比基于当前正文；行号从 1 开始，偏移从 0 开始、结束位置不包含在内。重复文本无法确定位置时标记为 ambiguous。PATCH 只替换该节选，保留其余正文。") };
  }
  private async resolveNodeShare(share: Share, node: AgentNode): Promise<ShareResult> {
    if (node.type === "snippet") {
      const content = share.selection ?? node.content;
      if (share.selection !== undefined && !node.content.includes(share.selection)) throw new StoreError(410, t("分享选段已不在当前正文中"));
      return { shareId: share.id, kind: "text", title: node.title, background: node.background, content, updated: node.updated, filePath: await this.nodeFileAbsPath(node.id), ...this.selectionDetails(share, node.content) };
    }
    if (!node.path) throw new StoreError(410, t("笔记缺少文件地址"));
    const stat = await fsp.stat(node.path).catch(() => null);
    if (!stat) throw new StoreError(410, t("分享目标已不存在"));
    return stat.isDirectory() ? this.resolveFolderShare(share, node.path, node.path, node.background, node.title) : this.resolveFileShare(share, node.path, node.path, node.background, node.title);
  }
  private async resolveFileShare(share: Share, address: string, abs: string, background = share.background ?? "", title = path.basename(address)): Promise<ShareResult> {
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw new StoreError(410, t("分享文件已不存在: {0}", address));
    const body = await fsp.readFile(abs, "utf8");
    const content = share.selection ?? body;
    if (share.selection !== undefined && !body.includes(share.selection)) throw new StoreError(410, t("分享选段已不在当前文件中"));
    return { shareId: share.id, kind: "file", title, background, address, content, updated: stat.mtime.toISOString(), filePath: abs, ...this.selectionDetails(share, body) };
  }
  private async resolveFolderShare(share: Share, address: string, abs: string, background = share.background ?? "", title = path.basename(address)): Promise<ShareResult> {
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat?.isDirectory()) throw new StoreError(410, t("分享文件夹已不存在: {0}", address));
    const entries = (await fsp.readdir(abs, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)).map((item) => item.isDirectory() ? `${item.name}/` : item.name);
    return { shareId: share.id, kind: "folder", title, background, address, entries, updated: stat.mtime.toISOString(), filePath: abs, hint: t(SHARE_HINT) };
  }

  warningsFor(node: AgentNode) { return qualityWarnings(node); }
}
