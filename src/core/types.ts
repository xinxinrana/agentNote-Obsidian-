/**
 * Core types for agentNote. Shared by the Obsidian plugin layer and the
 * standalone HTTP server used by agents. No dependency on `obsidian` here.
 */

export type NodeType = "snippet" | "file" | "folder";
export type NodeSource = "user" | "agent";

/** Boundary fields every memory must answer. */
export interface Boundary {
  /** 背景：这条记忆从哪来、为什么存在 */
  background: string;
  /** 适用场景：什么情况下应该用它 */
  scenarios: string;
  /** 注意与失效条件：什么时候不该用 / 何时过期 */
  caveats: string;
}

export interface AgentNode {
  id: string;
  type: NodeType;
  title: string;
  tags: string[];
  boundary: Boundary;
  source: NodeSource;
  /** For file/folder nodes: absolute path on disk being indexed. */
  path?: string;
  /** Body content. For snippet nodes this IS the memory; for file/folder
   *  nodes it's an optional human/agent-written description of the target. */
  content: string;
  created: string; // ISO
  updated: string; // ISO
}

/**
 * What a share points at. Everything in the vault is shareable:
 * - node:   an agentNote memory node (carries boundary/warnings)
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
  /** Legacy node shares carry nodeId directly; new shares carry target. */
  nodeId?: string;
  target?: ShareTarget;
  /** Exact text span of the target's content (live-checked at resolve time). */
  selection?: string;
  created: string;
  revoked: boolean;
  revokedAt?: string;
}

/** Normalize a share to its target (back-compat with legacy nodeId shares). */
export function shareTarget(share: Share): ShareTarget {
  if (share.target) return share.target;
  return { kind: "node", nodeId: share.nodeId ?? "" };
}

export interface Group {
  id: string;
  name: string;
  parentId: string | null;
}

export interface GroupsData {
  groups: Group[];
  /** nodeId -> groupIds (many-to-many) */
  membership: Record<string, string[]>;
}

export interface QualityWarning {
  code: "missing-boundary";
  message: string;
  missing: (keyof Boundary)[];
}

/** Compute quality warnings for a node (PRD FR-8). */
export function qualityWarnings(node: AgentNode): QualityWarning[] {
  if (node.source === "user") return [];
  const missing = (Object.keys(node.boundary) as (keyof Boundary)[]).filter(
    (k) => !node.boundary[k] || !node.boundary[k].trim()
  );
  if (missing.length === 0) return [];
  return [
    {
      code: "missing-boundary",
      message: `这条记忆由「${node.source}」写入，缺少边界字段：${missing.join(
        ", "
      )}。信任它之前请先补全。`,
      missing,
    },
  ];
}

export function emptyBoundary(): Boundary {
  return { background: "", scenarios: "", caveats: "" };
}
