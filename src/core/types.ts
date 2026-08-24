/**
 * Core types for agentNote. Shared by the Obsidian plugin layer and the
 * standalone HTTP server used by agents. No dependency on `obsidian` here.
 */

export type NodeType = "snippet" | "file" | "folder";
export type NodeSource = "user" | "agent";

export interface AgentNode {
  id: string;
  type: NodeType;
  title: string;
  tags: string[];
  /** 背景：这条记忆从哪来、为什么存在。唯一的边界字段（单字段 schema）。 */
  background: string;
  source: NodeSource;
  /** For file/folder nodes: absolute path on disk being indexed. */
  path?: string;
  /** Body content. For snippet nodes this IS the memory; for file/folder
   *  nodes it's an optional human/agent-written description of the target. */
  content: string;
  created: string; // ISO, from file stat (birthtime)
  updated: string; // ISO, from file stat (mtime)
  /** Derived from file location (agentNote/nodes/归档/ = archived).
   *  Never serialized to frontmatter. */
  archived: boolean;
}

/**
 * What a share points at. Everything in the vault is shareable:
 * - node:   an agentNote memory node (carries background/warnings)
 * - file:   any vault file (vault-relative path) — resolved live from disk
 * - folder: any vault folder (vault-relative path) — resolved to a live listing
 *
 * Selection shares are live too: the exact span is searched in the target's
 * CURRENT content at resolve time.
 */
export type ShareTarget =
  | { kind: "node"; nodeId: string }
  | { kind: "file"; path: string }
  | { kind: "folder"; path: string };

export interface Share {
  id: string; // "s-x-..."
  target: ShareTarget;
  /** Exact text span of the target's content (live-checked at resolve time). */
  selection?: string;
  /** Context supplied for a direct file/folder share. Node shares use the node background. */
  background?: string;
  created: string;
}

/** Normalize a share to its target (back-compat with legacy nodeId shares). */
export function shareTarget(share: Share): ShareTarget {
  return share.target;
}

export interface QualityWarning {
  code: "missing-background";
  message: string;
}

/** Compute quality warnings for a node (FR-8). Agent-written memories must
 *  carry a 「背景」; user-written ones are trusted as-is. */
export function qualityWarnings(node: AgentNode): QualityWarning[] {
  if (node.source === "user") return [];
  if (node.background && node.background.trim()) return [];
  return [
    {
      code: "missing-background",
      message: `这条记忆由「${node.source}」写入，缺少「背景」字段。信任它之前请先补全。`,
    },
  ];
}

/** Obsidian tags cannot contain spaces: whitespace is stripped on write so
 *  agents don't silently get a different tag back than they sent. */
export function normalizeTags(tags: string[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    const cleaned = String(t).replace(/\s+/g, "").trim();
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}
