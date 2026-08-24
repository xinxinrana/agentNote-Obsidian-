/**
 * Node file (de)serialization.
 *
 * Every agentNote node is a plain markdown file with YAML frontmatter.
 * This is the on-disk single source of truth (PRD 原则 4: 不绑架用户数据) —
 * after uninstall the files remain fully readable by any text tool.
 *
 * A node file looks like:
 *
 *   ---
 *   agentnote: true
 *   id: n-abc123
 *   type: snippet            # snippet | file | folder
 *   source: agent            # user | agent
 *   背景: 用户在 8/13 反馈后定稿的单字段……
 *   tags: [api, backend]
 *   path: D:/work/config.yml # file/folder nodes only
 *   ---
 *
 *   Body content...
 *
 * Deliberately minimal: title = file name, created/updated = file stat
 * (birthtime / mtime), archived = lives in nodes/归档/. Nothing else is
 * serialized, so renaming a file renames the node and git keeps history.
 *
 * Parsing is lenient toward the retired three-field layout: a legacy
 * `boundary.background` (or a `title:` key) is still read if present, so an
 * old file never loses its memory — it just gets rewritten in the new shape
 * on its next save.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { AgentNode, NodeSource, NodeType } from "./types";

const FM_MARKER = "agentnote";

/** Facts that live outside the file content (file name + stat + location). */
export interface NodeMeta {
  /** File name without extension — this IS the node title. */
  title: string;
  /** ISO, from file stat birthtime. */
  created: string;
  /** ISO, from file stat mtime. */
  updated: string;
  /** Derived from living under nodes/归档/. Never serialized. */
  archived: boolean;
}

export function serializeNode(node: AgentNode): string {
  const fm: Record<string, unknown> = {
    [FM_MARKER]: true,
    id: node.id,
    type: node.type,
    source: node.source,
    背景: node.background ?? "",
    tags: node.tags,
  };
  if (node.path) fm.path = node.path;
  const yaml = stringifyYaml(fm, { lineWidth: 0 }).trimEnd();
  const body = node.content.replace(/\s*$/, "");
  return `---\n${yaml}\n---\n\n${body}\n`;
}

export class NodeParseError extends Error {}

export function isNodeFile(raw: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return false;
  try {
    const data = parseYaml(m[1]);
    return !!data && typeof data === "object" && data[FM_MARKER] === true;
  } catch {
    return false;
  }
}

export function parseNode(raw: string, meta: NodeMeta): AgentNode {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new NodeParseError("missing frontmatter block");
  let data: Record<string, unknown>;
  try {
    data = parseYaml(m[1]) as Record<string, unknown>;
  } catch (e) {
    throw new NodeParseError(`invalid YAML frontmatter: ${(e as Error).message}`);
  }
  if (!data || data[FM_MARKER] !== true) throw new NodeParseError("not an agentnote node file");

  // 单字段 schema：「背景」. Lenient fallback for the retired three-field
  // layout: boundary.background is salvaged so old files lose nothing.
  let background = typeof data["背景"] === "string" ? data["背景"] : "";
  if (!background) {
    const legacy = data.boundary as { background?: unknown } | undefined;
    if (legacy && typeof legacy.background === "string") background = legacy.background;
  }

  // Title normally comes from the file name; a legacy `title:` key wins so
  // id-named legacy files keep their real name through migration.
  const fmTitle = typeof data.title === "string" ? data.title.trim() : "";

  return {
    id: String(data.id ?? ""),
    type: (data.type as NodeType) ?? "snippet",
    title: fmTitle || meta.title,
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    source: (data.source as NodeSource) ?? "user",
    background,
    path: typeof data.path === "string" ? data.path : undefined,
    content: (m[2] ?? "").replace(/^\n+/, "").replace(/\s*$/, ""),
    created: meta.created || String(data.created ?? ""),
    updated: meta.updated || String(data.updated ?? ""),
    archived: meta.archived,
  };
}
