import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { randomBytes } from "crypto";
import { isNodeFile, parseNode, serializeNode } from "./nodeFile";
import { AgentNode, NodeSource, NodeType, Share, ShareTarget, normalizeTags, qualityWarnings } from "./types";

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
}
export interface UpdateNodeInput {
  title?: string;
  content?: string;
  background?: string;
  tags?: string[];
  path?: string;
  source?: NodeSource;
}

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

  constructor(vaultRoot: string) {
    this.root = path.resolve(vaultRoot);
    this.dataDir = path.join(this.root, "agentNote");
  }
  private p(...parts: string[]): string { return path.join(this.dataDir, ...parts); }

  async init(): Promise<void> {
    await Promise.all([fsp.mkdir(this.p("nodes"), { recursive: true }), fsp.mkdir(this.p("data"), { recursive: true })]);
    const shares = this.p("data", "shares.json");
    if (!fs.existsSync(shares)) await fsp.writeFile(shares, "[]", "utf8");
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

  async createNode(input: CreateNodeInput): Promise<AgentNode> {
    if (!input.title?.trim()) throw new StoreError(400, "标题不能为空");
    const type = input.type ?? "snippet";
    if ((type === "file" || type === "folder") && !input.path?.trim()) throw new StoreError(400, `${type} 笔记需要文件地址`);
    const now = new Date().toISOString();
    const node: AgentNode = { id: newId("n"), type, title: input.title.trim(), content: input.content ?? "", background: input.background?.trim() ?? "", tags: normalizeTags(input.tags), source: input.source ?? "agent", path: input.path?.trim() || undefined, created: now, updated: now, archived: false };
    await this.writeNode(node);
    return node;
  }
  async updateNode(id: string, patch: UpdateNodeInput): Promise<AgentNode> {
    const node = await this.getNode(id);
    if (patch.title !== undefined) node.title = patch.title.trim();
    if (patch.content !== undefined) node.content = patch.content;
    if (patch.background !== undefined) node.background = patch.background;
    if (patch.tags !== undefined) node.tags = normalizeTags(patch.tags);
    if (patch.path !== undefined) node.path = patch.path || undefined;
    if (patch.source !== undefined) node.source = patch.source;
    node.updated = new Date().toISOString();
    await this.writeNode(node);
    return node;
  }
  async archiveNode(id: string, archived: boolean): Promise<AgentNode> {
    const node = await this.getNode(id);
    node.archived = archived;
    await this.writeNode(node);
    return node;
  }

  private async readShares(): Promise<Share[]> {
    try { return JSON.parse(await fsp.readFile(this.p("data", "shares.json"), "utf8")); } catch { return []; }
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

  async resolveShare(id: string): Promise<ShareResult> {
    const share = (await this.readShares()).find((candidate) => candidate.id === id);
    if (!share) throw new StoreError(404, `分享不存在: ${id}`);
    if (share.target.kind === "node") return this.resolveNodeShare(share, await this.getNode(share.target.nodeId));
    const { rel, abs } = this.vaultPath(share.target.path);
    return share.target.kind === "file" ? this.resolveFileShare(share, rel, abs) : this.resolveFolderShare(share, rel, abs);
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
