/**
 * VaultStore — the storage engine for agentNote.
 *
 * Pure Node.js (fs/path only), zero Obsidian imports, so the exact same
 * engine powers the plugin's embedded HTTP server and the standalone
 * black-box e2e tests.
 *
 * On-disk layout inside the vault (all plain text, git-friendly):
 *
 *   agentNote/
 *     nodes/<title>.md           one markdown file per node, named after its
 *                                title; the stable id lives in frontmatter
 *     snapshots/<id>/<ts>/...    read-only backup copies of file/folder targets
 *     snapshots/<id>/index.json  snapshot records
 *     data/shares.json           share references (s-x-...), incl. revoked flag
 *     data/groups.json           virtual groups + many-to-many membership
 *
 * Version history is deliberately NOT kept here: the vault is meant to live
 * under git, which does the job better (PRD FR-4 superseded by user decision
 * 2026-07-29). init() migrates the legacy layout (id-named files, versions/
 * directory) automatically: files are renamed to their title, the `version`
 * frontmatter key is dropped, and versions/ is moved aside to
 * versions.legacy-backup/ (never silently deleted).
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { randomBytes } from "crypto";
import { parseNode, serializeNode, isNodeFile } from "./nodeFile";
import {
  AgentNode,
  Boundary,
  Group,
  GroupsData,
  NodeSource,
  NodeType,
  QualityWarning,
  Share,
  emptyBoundary,
  qualityWarnings,
  shareTarget,
} from "./types";

export class StoreError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
  }
}

export interface NodeFilter {
  tag?: string;
  q?: string; // keyword, matched against title/content/tags (case-insensitive)
  type?: NodeType;
}

export interface CreateNodeInput {
  type: NodeType;
  title: string;
  content?: string;
  boundary?: Partial<Boundary>;
  tags?: string[];
  source?: NodeSource;
  path?: string; // required for file/folder nodes
}

export interface UpdateNodeInput {
  title?: string;
  content?: string;
  boundary?: Partial<Boundary>;
  tags?: string[];
  path?: string;
  source?: NodeSource; // who performed this update (defaults to "user")
}

export interface SnapshotRecord {
  timestamp: string;
  dir: string; // path relative to vault root
  note?: string;
}

/**
 * What a resolving agent gets. Deliberately loosely coupled to the source:
 * whatever the target actually has is what shows up — a node brings its
 * boundary/warnings, a plain vault file just brings its title and content.
 */
export interface ResolveResult {
  shareId: string;
  scope: "full" | "selection" | "listing";
  /** A little context: node title, file name, or folder name. */
  title: string;
  content: string;
  /** node.updated, or the file/folder mtime. */
  updated?: string;
  /** Present for node shares (back-compat + boundary/warnings context). */
  nodeId?: string;
  nodeTitle?: string;
  boundary?: Boundary;
  source?: NodeSource;
  warnings?: QualityWarning[];
}

export interface InitResult {
  /** legacy id-named files renamed to title-based names */
  migratedNodes: number;
  /** set when a legacy versions/ dir was moved aside (vault-relative) */
  legacyVersionsBackup: string | null;
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

/** Make a title safe as a Windows/macOS/Linux file name. */
function safeFileBase(title: string, fallback: string): string {
  const cleaned = title
    .replace(/[\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "") // Windows forbids trailing dots/spaces
    .slice(0, 80)
    .replace(/[. ]+$/, "");
  return cleaned || fallback;
}

export class VaultStore {
  readonly root: string; // vault root (absolute)
  readonly dataDir: string; // <vault>/agentNote

  constructor(vaultRoot: string) {
    this.root = path.resolve(vaultRoot);
    this.dataDir = path.join(this.root, "agentNote");
  }

  private p(...segs: string[]): string {
    return path.join(this.dataDir, ...segs);
  }

  async init(): Promise<InitResult> {
    await fsp.mkdir(this.p("nodes"), { recursive: true });
    await fsp.mkdir(this.p("snapshots"), { recursive: true });
    await fsp.mkdir(this.p("data"), { recursive: true });
    for (const [file, fallback] of [
      ["shares.json", "[]"],
      ["groups.json", JSON.stringify({ groups: [], membership: {} })],
    ] as const) {
      const fp = this.p("data", file);
      if (!fs.existsSync(fp)) await fsp.writeFile(fp, fallback, "utf8");
    }
    return this.migrateLegacyLayout();
  }

  // ---------- node files ----------

  /** Cache: file path -> { mtimeMs, node }. User edits in Obsidian change the
   *  mtime, so the cache stays correct while avoiding full re-parses. */
  private cache = new Map<string, { mtimeMs: number; node: AgentNode }>();
  /** nodeId -> absolute file path, rebuilt on every scan. */
  private idToPath = new Map<string, string>();

  private async scanNodes(): Promise<AgentNode[]> {
    const dir = this.p("nodes");
    let files: string[] = [];
    try {
      files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".md"));
    } catch {
      return [];
    }
    const out: AgentNode[] = [];
    const seen = new Set<string>();
    const idToPath = new Map<string, string>();
    for (const f of files) {
      const fp = path.join(dir, f);
      seen.add(fp);
      try {
        const st = await fsp.stat(fp);
        const hit = this.cache.get(fp);
        if (hit && hit.mtimeMs === st.mtimeMs) {
          out.push(hit.node);
          idToPath.set(hit.node.id, fp);
          continue;
        }
        const raw = await fsp.readFile(fp, "utf8");
        if (!isNodeFile(raw)) continue;
        const node = parseNode(raw);
        this.cache.set(fp, { mtimeMs: st.mtimeMs, node });
        idToPath.set(node.id, fp);
        out.push(node);
      } catch {
        // skip unreadable / malformed files; they remain readable on disk
      }
    }
    for (const key of [...this.cache.keys()]) {
      if (!seen.has(key) && key.startsWith(dir)) this.cache.delete(key);
    }
    this.idToPath = idToPath;
    return out;
  }

  /** Pick a free title-based file name for a node. A file that already
   *  belongs to this same node id counts as free (in-place rewrite). */
  private async uniqueNodeFile(title: string, selfId: string): Promise<string> {
    const base = safeFileBase(title, selfId);
    for (let i = 1; ; i++) {
      const name = i === 1 ? `${base}.md` : `${base} ${i}.md`;
      const fp = this.p("nodes", name);
      if (!fs.existsSync(fp)) return fp;
      if (this.idToPath.get(selfId) === fp) return fp;
    }
  }

  async listNodes(filter: NodeFilter = {}): Promise<AgentNode[]> {
    let nodes = await this.scanNodes();
    if (filter.type) nodes = nodes.filter((n) => n.type === filter.type);
    if (filter.tag) {
      const tag = filter.tag.toLowerCase();
      nodes = nodes.filter((n) => n.tags.some((t) => t.toLowerCase() === tag));
    }
    if (filter.q) {
      const q = filter.q.toLowerCase();
      nodes = nodes.filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          n.content.toLowerCase().includes(q) ||
          n.tags.some((t) => t.toLowerCase().includes(q))
      );
    }
    nodes.sort((a, b) => b.updated.localeCompare(a.updated));
    return nodes;
  }

  async getNode(id: string): Promise<AgentNode> {
    const nodes = await this.scanNodes();
    const node = nodes.find((n) => n.id === id);
    if (!node) throw new StoreError(404, `节点不存在: ${id}`);
    return node;
  }

  /** Vault-relative path of a node's file (for opening it in Obsidian). */
  async nodeFilePath(id: string): Promise<string> {
    await this.scanNodes();
    const abs = this.idToPath.get(id);
    if (!abs) throw new StoreError(404, `节点不存在: ${id}`);
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  private async writeNode(node: AgentNode): Promise<void> {
    await this.scanNodes(); // populate idToPath so renames/collisions are correct
    const file = await this.uniqueNodeFile(node.title, node.id);
    const prev = this.idToPath.get(node.id);
    const raw = serializeNode(node);
    await fsp.writeFile(file, raw, "utf8");
    if (prev && prev !== file) {
      // title changed → the file follows it (id in frontmatter is stable)
      await fsp.rm(prev, { force: true });
      this.cache.delete(prev);
    }
    const st = await fsp.stat(file);
    this.cache.set(file, { mtimeMs: st.mtimeMs, node });
    this.idToPath.set(node.id, file);
  }

  async createNode(input: CreateNodeInput): Promise<AgentNode> {
    if (!input.title?.trim()) throw new StoreError(400, "标题不能为空");
    if ((input.type === "file" || input.type === "folder") && !input.path?.trim()) {
      throw new StoreError(400, `${input.type} 类型的节点必须提供磁盘路径`);
    }
    const now = new Date().toISOString();
    const node: AgentNode = {
      id: newId("n"),
      type: input.type,
      title: input.title.trim(),
      tags: input.tags ?? [],
      boundary: { ...emptyBoundary(), ...(input.boundary ?? {}) },
      source: input.source ?? "user",
      path: input.path?.trim() || undefined,
      content: input.content ?? "",
      created: now,
      updated: now,
    };
    await this.writeNode(node);
    return node;
  }

  async updateNode(id: string, patch: UpdateNodeInput): Promise<AgentNode> {
    const node = await this.getNode(id);
    if (patch.title !== undefined) node.title = patch.title;
    if (patch.content !== undefined) node.content = patch.content;
    if (patch.tags !== undefined) node.tags = patch.tags;
    if (patch.path !== undefined) node.path = patch.path || undefined;
    if (patch.boundary) node.boundary = { ...node.boundary, ...patch.boundary };
    node.updated = new Date().toISOString();
    const actor = patch.source ?? "user";
    // Who wrote it matters (FR-8): an agent edit re-marks the content as
    // agent-sourced so boundary review stays mandatory.
    node.source = actor;
    await this.writeNode(node);
    return node;
  }

  // ---------- legacy layout migration ----------

  /**
   * Pre-2026-07-29 layout: nodes/<id>.md files with a `version` frontmatter
   * key plus a versions/ directory. Rename files to their title, rewrite
   * frontmatter without `version`, and move versions/ aside (kept, not
   * deleted — the user can remove it once git has the history).
   */
  private async migrateLegacyLayout(): Promise<InitResult> {
    let legacyVersionsBackup: string | null = null;
    const versionsDir = this.p("versions");
    if (fs.existsSync(versionsDir)) {
      const backup = this.p("versions.legacy-backup");
      if (!fs.existsSync(backup)) {
        await fsp.rename(versionsDir, backup);
        legacyVersionsBackup = path
          .relative(this.root, backup)
          .split(path.sep)
          .join("/");
      } else {
        await fsp.rm(versionsDir, { recursive: true, force: true });
      }
    }

    let migratedNodes = 0;
    const dir = this.p("nodes");
    const files = fs.existsSync(dir)
      ? (await fsp.readdir(dir)).filter((f) => f.endsWith(".md"))
      : [];
    for (const f of files) {
      const fp = path.join(dir, f);
      let raw: string;
      try {
        raw = await fsp.readFile(fp, "utf8");
      } catch {
        continue;
      }
      if (!isNodeFile(raw)) continue;
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "";
      const legacyName = /^n-[0-9a-f]{12}\.md$/i.test(f);
      const hasVersionKey = /^version:/m.test(fm);
      if (!legacyName && !hasVersionKey) continue;
      let node: AgentNode;
      try {
        node = parseNode(raw);
      } catch {
        continue;
      }
      await this.writeNode(node); // renames if needed; serialize drops `version`
      migratedNodes++;
    }
    if (migratedNodes > 0) await this.scanNodes();
    return { migratedNodes, legacyVersionsBackup };
  }

  // ---------- shares ----------

  private async readShares(): Promise<Share[]> {
    try {
      return JSON.parse(await fsp.readFile(this.p("data", "shares.json"), "utf8"));
    } catch {
      return [];
    }
  }

  private async writeShares(shares: Share[]): Promise<void> {
    await fsp.writeFile(this.p("data", "shares.json"), JSON.stringify(shares, null, 2), "utf8");
  }

  async createShare(nodeId: string, selection?: string): Promise<Share> {
    const node = await this.getNode(nodeId);
    if (selection !== undefined) {
      if (!selection.trim()) throw new StoreError(400, "选段不能为空");
      if (!node.content.includes(selection)) {
        throw new StoreError(400, "选段已不在节点当前正文中");
      }
    }
    return this.appendShare({
      id: newId("s-x"),
      nodeId, // kept for back-compat; target is the source of truth
      target: { kind: "node", nodeId },
      selection,
      created: new Date().toISOString(),
      revoked: false,
    });
  }

  /** Validate a vault-relative path and return its normalized form + absolute path. */
  private vaultPath(relPath: string): { rel: string; abs: string } {
    const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (!rel || rel.split("/").includes("..")) {
      throw new StoreError(400, "路径必须是 vault 内的相对路径（拒绝绝对路径与 ..）");
    }
    return { rel, abs: path.join(this.root, ...rel.split("/")) };
  }

  /** Share any vault file. Resolution reads the CURRENT file content, live. */
  async createFileShare(relPath: string, selection?: string): Promise<Share> {
    const { rel, abs } = this.vaultPath(relPath);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw new StoreError(404, `vault 里找不到文件: ${rel}`);
    if (selection !== undefined) {
      if (!selection.trim()) throw new StoreError(400, "选段不能为空");
      const content = await fsp.readFile(abs, "utf8");
      if (!content.includes(selection)) {
        throw new StoreError(400, "选段已不在文件当前内容中");
      }
    }
    return this.appendShare({
      id: newId("s-x"),
      target: { kind: "file", path: rel },
      selection,
      created: new Date().toISOString(),
      revoked: false,
    });
  }

  /** Share any vault folder. Resolution returns a live listing of its files. */
  async createFolderShare(relPath: string): Promise<Share> {
    const { rel, abs } = this.vaultPath(relPath);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat?.isDirectory()) throw new StoreError(404, `vault 里找不到文件夹: ${rel}`);
    return this.appendShare({
      id: newId("s-x"),
      target: { kind: "folder", path: rel },
      created: new Date().toISOString(),
      revoked: false,
    });
  }

  /** Share a vault path, dispatching on whether it is a file or a folder. */
  async createPathShare(relPath: string, selection?: string): Promise<Share> {
    const { rel, abs } = this.vaultPath(relPath);
    const stat = await fsp.stat(abs).catch(() => null);
    if (stat?.isDirectory()) {
      if (selection !== undefined) throw new StoreError(400, "文件夹不能按选段分享");
      return this.createFolderShare(rel);
    }
    return this.createFileShare(rel, selection);
  }

  private async appendShare(share: Share): Promise<Share> {
    const shares = await this.readShares();
    shares.push(share);
    await this.writeShares(shares);
    return share;
  }

  async listShares(): Promise<Share[]> {
    return this.readShares();
  }

  async revokeShare(id: string): Promise<Share> {
    const shares = await this.readShares();
    const share = shares.find((s) => s.id === id);
    if (!share) throw new StoreError(404, `分享引用不存在: ${id}`);
    share.revoked = true;
    share.revokedAt = new Date().toISOString();
    await this.writeShares(shares);
    return share;
  }

  /** Live resolution (FR-5): always reads the target's CURRENT content. */
  async resolveShare(id: string): Promise<ResolveResult> {
    const shares = await this.readShares();
    const share = shares.find((s) => s.id === id);
    if (!share) throw new StoreError(404, `分享引用不存在: ${id}`);
    if (share.revoked) throw new StoreError(410, `分享已被吊销: ${id}`);
    const target = shareTarget(share);
    if (target.kind === "node") return this.resolveNodeShare(share, target.nodeId);
    if (target.kind === "file") return this.resolveFileShare(share, target.path);
    return this.resolveFolderShare(share, target.path);
  }

  private async resolveNodeShare(share: Share, nodeId: string): Promise<ResolveResult> {
    const node = await this.getNode(nodeId);
    let content: string;
    let scope: "full" | "selection";
    if (share.selection !== undefined) {
      const idx = node.content.indexOf(share.selection);
      if (idx === -1) {
        throw new StoreError(
          410,
          "分享的选段已不在节点当前正文中"
        );
      }
      content = share.selection;
      scope = "selection";
    } else {
      content = node.content;
      scope = "full";
    }
    return {
      shareId: share.id,
      nodeId: node.id,
      nodeTitle: node.title,
      title: node.title,
      scope,
      content,
      updated: node.updated,
      boundary: node.boundary,
      source: node.source,
      warnings: qualityWarnings(node),
    };
  }

  /** Plain vault file: whatever it currently is, plus its name and mtime. No boundary required. */
  private async resolveFileShare(share: Share, rel: string): Promise<ResolveResult> {
    const { abs } = this.vaultPath(rel);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat?.isFile()) throw new StoreError(410, `分享的文件已被删除: ${rel}`);
    const fileContent = await fsp.readFile(abs, "utf8");
    let content: string;
    let scope: "full" | "selection";
    if (share.selection !== undefined) {
      if (!fileContent.includes(share.selection)) {
        throw new StoreError(
          410,
          "分享的选段已不在文件当前内容中"
        );
      }
      content = share.selection;
      scope = "selection";
    } else {
      content = fileContent;
      scope = "full";
    }
    return {
      shareId: share.id,
      title: path.basename(rel).replace(/\.[^.]+$/, ""),
      scope,
      content,
      updated: stat.mtime.toISOString(),
    };
  }

  /** Folder: a live listing of its files (recursive, capped), plus name and mtime. */
  private async resolveFolderShare(share: Share, rel: string): Promise<ResolveResult> {
    const { abs } = this.vaultPath(rel);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat?.isDirectory()) throw new StoreError(410, `分享的文件夹已被删除: ${rel}`);
    const MAX_ENTRIES = 500;
    const entries: string[] = [];
    let truncated = false;
    const walk = async (dir: string, prefix: string): Promise<void> => {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const items = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      for (const item of items) {
        if (entries.length >= MAX_ENTRIES) {
          truncated = true;
          return;
        }
        const relItem = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isDirectory()) await walk(path.join(dir, item.name), relItem);
        else entries.push(relItem);
      }
    };
    await walk(abs, "");
    const listing =
      entries.join("\n") + (truncated ? `\n… (truncated at ${MAX_ENTRIES} entries)` : "");
    return {
      shareId: share.id,
      title: path.basename(rel) || rel,
      scope: "listing",
      content: listing,
      updated: stat.mtime.toISOString(),
    };
  }

  // ---------- groups ----------

  private async readGroups(): Promise<GroupsData> {
    try {
      const data = JSON.parse(await fsp.readFile(this.p("data", "groups.json"), "utf8"));
      return { groups: data.groups ?? [], membership: data.membership ?? {} };
    } catch {
      return { groups: [], membership: {} };
    }
  }

  private async writeGroups(data: GroupsData): Promise<void> {
    await fsp.writeFile(this.p("data", "groups.json"), JSON.stringify(data, null, 2), "utf8");
  }

  async listGroups(): Promise<GroupsData> {
    return this.readGroups();
  }

  async createGroup(name: string, parentId: string | null = null): Promise<Group> {
    if (!name?.trim()) throw new StoreError(400, "分组名不能为空");
    const data = await this.readGroups();
    if (parentId && !data.groups.some((g) => g.id === parentId)) {
      throw new StoreError(404, `父分组不存在: ${parentId}`);
    }
    const group: Group = { id: newId("g"), name: name.trim(), parentId };
    data.groups.push(group);
    await this.writeGroups(data);
    return group;
  }

  async deleteGroup(id: string): Promise<void> {
    const data = await this.readGroups();
    const ids = new Set<string>([id]);
    // collect descendants
    let grew = true;
    while (grew) {
      grew = false;
      for (const g of data.groups) {
        if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) {
          ids.add(g.id);
          grew = true;
        }
      }
    }
    data.groups = data.groups.filter((g) => !ids.has(g.id));
    for (const nodeId of Object.keys(data.membership)) {
      data.membership[nodeId] = data.membership[nodeId].filter((g) => !ids.has(g));
    }
    await this.writeGroups(data);
  }

  /** Set the full group list for a node (many-to-many, FR-6). */
  async setNodeGroups(nodeId: string, groupIds: string[]): Promise<void> {
    await this.getNode(nodeId); // 404 if missing
    const data = await this.readGroups();
    for (const gid of groupIds) {
      if (!data.groups.some((g) => g.id === gid)) {
        throw new StoreError(404, `分组不存在: ${gid}`);
      }
    }
    data.membership[nodeId] = [...new Set(groupIds)];
    await this.writeGroups(data);
  }

  // ---------- snapshots (FR-7) ----------

  private snapshotIndexFile(nodeId: string): string {
    return this.p("snapshots", nodeId, "index.json");
  }

  async listSnapshots(nodeId: string): Promise<SnapshotRecord[]> {
    try {
      return JSON.parse(await fsp.readFile(this.snapshotIndexFile(nodeId), "utf8"));
    } catch {
      return [];
    }
  }

  /** Read-only backup copy of a file/folder node's target. The original is
   *  never modified (原则 6); the snapshot is a separate frozen copy. */
  async createSnapshot(nodeId: string, note?: string): Promise<SnapshotRecord> {
    const node = await this.getNode(nodeId);
    if (node.type === "snippet") {
      throw new StoreError(400, "只有 file/folder 类型的节点才能做快照");
    }
    const target = node.path!;
    if (!fs.existsSync(target)) throw new StoreError(404, `磁盘目标不存在: ${target}`);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const destDir = this.p("snapshots", nodeId, ts);
    await fsp.mkdir(destDir, { recursive: true });
    const st = await fsp.stat(target);
    if (st.isDirectory()) {
      await fsp.cp(target, path.join(destDir, path.basename(target)), { recursive: true });
    } else {
      await fsp.copyFile(target, path.join(destDir, path.basename(target)));
    }
    const record: SnapshotRecord = {
      timestamp: new Date().toISOString(),
      dir: path.relative(this.root, destDir),
      note,
    };
    const index = await this.listSnapshots(nodeId);
    index.push(record);
    await fsp.mkdir(path.dirname(this.snapshotIndexFile(nodeId)), { recursive: true });
    await fsp.writeFile(this.snapshotIndexFile(nodeId), JSON.stringify(index, null, 2), "utf8");
    return record;
  }

  /** Quality signal for API consumers (FR-8). */
  warningsFor(node: AgentNode): QualityWarning[] {
    return qualityWarnings(node);
  }
}
