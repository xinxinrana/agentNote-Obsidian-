import { isExcludedFolder } from "./excludedFolders";
import type { InsightEvent } from "./store";

export interface HistoryAdapter { exists(path: string): Promise<boolean>; read(path: string): Promise<string>; list(path: string): Promise<{ files: string[]; folders: string[] }> }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isHistoryEvent(value: unknown): value is InsightEvent {
  if (!isRecord(value) || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) || typeof value.type !== "string") return false;
  if (["path", "sourcePath", "previousPath", "title", "nodeId", "documentId", "eventId"].some(key => value[key] !== undefined && typeof value[key] !== "string")) return false;
  return value.actor === undefined || (isRecord(value.actor) && typeof value.actor.name === "string");
}
/** Read only the canonical logs, never backup snapshots. No Node APIs or vault writes. */
export async function readMobileHistory(adapter: HistoryAdapter, excludedFolders: string[]) {
  const directory = "agentNote/data";
  const events = new Map<string, InsightEvent>();
  const conflicted = new Set<string>();
  const issues: string[] = [];
  const read = async (file: string) => {
    try {
      const value: unknown = JSON.parse(await adapter.read(file));
      const items: unknown[] = Array.isArray(value) ? value : [value];
      for (const event of items) {
        if (!isHistoryEvent(event)) throw new Error(file);
        const signature = JSON.stringify(Object.fromEntries(Object.entries(event).sort(([a], [b]) => a.localeCompare(b))));
        const id = event.eventId || signature;
        const previous = events.get(id);
        if (previous && JSON.stringify(Object.fromEntries(Object.entries(previous).sort(([a], [b]) => a.localeCompare(b)))) !== signature) { conflicted.add(id); issues.push(file); }
        events.set(id, event);
      }
    } catch { issues.push(file); }
  };
  const list = async (folder: string) => {
    try { return await adapter.list(folder); } catch { issues.push(folder); return { files: [], folders: [] }; }
  };
  const exists = async (folder: string) => { try { return await adapter.exists(folder); } catch { issues.push(folder); return false; } };
  if (!await exists(directory)) return { events: [], issues };
  const top = await list(directory);
  for (const file of top.files.filter(file => /(?:^|\/)events(?:\.[^/]+)?\.json$/.test(file))) await read(file);
  const shards = directory + "/events";
  if (await exists(shards)) {
    const months = await list(shards);
    for (const month of months.folders.filter(folder => /\/\d{4}-\d{2}$/.test(folder))) {
      for (const file of (await list(month)).files.filter(file => file.endsWith(".json"))) await read(file);
    }
  }
  return { events: [...events].filter(([id, event]) => !conflicted.has(id) && ![event.path, event.sourcePath, event.previousPath].some(p => p !== undefined && isExcludedFolder(p, excludedFolders))).map(([,event]) => event).sort((a,b) => b.at.localeCompare(a.at)), issues: [...new Set(issues)] };
}
