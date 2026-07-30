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
 *   title: My memory
 *   tags: [api, backend]
 *   source: agent            # user | agent
 *   created: 2026-07-28T...
 *   updated: 2026-07-28T...
 *   path: D:/work/config.yml # file/folder nodes only
 *   boundary:
 *     background: ...
 *     scenarios: ...
 *     caveats: ...
 *   ---
 *
 *   Body content...
 *
 * The file on disk is named after the title (<title>.md); the id lives in
 * frontmatter and is the stable reference for shares/groups. History is
 * delegated to git — no version field, no version directory.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { AgentNode, Boundary, NodeSource, NodeType, emptyBoundary } from "./types";

const FM_MARKER = "agentnote";

export function serializeNode(node: AgentNode): string {
  const fm: Record<string, unknown> = {
    [FM_MARKER]: true,
    id: node.id,
    type: node.type,
    title: node.title,
    tags: node.tags,
    source: node.source,
    created: node.created,
    updated: node.updated,
  };
  if (node.path) fm.path = node.path;
  fm.boundary = {
    background: node.boundary.background,
    scenarios: node.boundary.scenarios,
    caveats: node.boundary.caveats,
  };
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

export function parseNode(raw: string): AgentNode {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new NodeParseError("missing frontmatter block");
  let data: Record<string, unknown>;
  try {
    data = parseYaml(m[1]) as Record<string, unknown>;
  } catch (e) {
    throw new NodeParseError(`invalid YAML frontmatter: ${(e as Error).message}`);
  }
  if (!data || data[FM_MARKER] !== true) throw new NodeParseError("not an agentnote node file");
  const b = (data.boundary ?? {}) as Partial<Boundary>;
  const boundary: Boundary = {
    ...emptyBoundary(),
    ...(typeof b.background === "string" ? { background: b.background } : {}),
    ...(typeof b.scenarios === "string" ? { scenarios: b.scenarios } : {}),
    ...(typeof b.caveats === "string" ? { caveats: b.caveats } : {}),
  };
  return {
    id: String(data.id ?? ""),
    type: (data.type as NodeType) ?? "snippet",
    title: String(data.title ?? ""),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    source: (data.source as NodeSource) ?? "user",
    path: typeof data.path === "string" ? data.path : undefined,
    boundary,
    content: (m[2] ?? "").replace(/^\n+/, "").replace(/\s*$/, ""),
    created: String(data.created ?? ""),
    updated: String(data.updated ?? ""),
  };
}
