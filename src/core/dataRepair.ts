import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface DataIssue { file: string; kind: 'missing' | 'conflict' | 'invalid' | 'unreadable'; canRepair: boolean }
export interface DataRepairResult { repaired: string[]; backups: string[]; remaining: DataIssue[] }
type DocumentRecord = { id: string; path: string; title: string; created: string; updated: string; deletedAt?: string; protected?: boolean; [key: string]: unknown };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validDocuments(value: unknown): value is DocumentRecord[] {
  return Array.isArray(value) && value.every(d => record(d) && ['id', 'path', 'title', 'created', 'updated'].every(key => typeof d[key] === 'string') && (d.deletedAt === undefined || typeof d.deletedAt === 'string') && (d.protected === undefined || typeof d.protected === 'boolean'));
}
function valid(name: string, value: unknown): boolean {
  if (name === 'documents.json') return validDocuments(value);
  if (name === 'references.json') return record(value) && Object.values(value).every(targets => Array.isArray(targets) && targets.every(target => typeof target === 'string'));
  return Array.isArray(value) && value.every(event => record(event) && typeof event.at === 'string' && typeof event.type === 'string' && (event.eventId === undefined || typeof event.eventId === 'string') && (event.deviceId === undefined || (typeof event.deviceId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(event.deviceId))));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical));
  if (record(value)) return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return JSON.stringify(value) ?? 'undefined';
}
/** Reconstruct both complete JSON versions, including diff3 conflict markers. */
export function mergeDocumentConflicts(raw: string): DocumentRecord[] | null {
  const left: string[] = [], right: string[] = [];
  let state: 'outside' | 'left' | 'base' | 'right' = 'outside';
  let conflicts = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (/^<{7,}(?: |$)/.test(line)) { if (state !== 'outside') return null; state = 'left'; conflicts++; }
    else if (/^\|{7,}(?: |$)/.test(line)) { if (state !== 'left') return null; state = 'base'; }
    else if (/^={7,}$/.test(line)) { if (state !== 'left' && state !== 'base') return null; state = 'right'; }
    else if (/^>{7,}(?: |$)/.test(line)) { if (state !== 'right') return null; state = 'outside'; }
    else { if (state === 'outside' || state === 'left') left.push(line); if (state === 'outside' || state === 'right') right.push(line); }
  }
  if (state !== 'outside' || !conflicts) return null;
  try {
    const a: unknown = JSON.parse(left.join('\n')), b: unknown = JSON.parse(right.join('\n'));
    if (!validDocuments(a) || !validDocuments(b)) return null;
    const merged = new Map<string, DocumentRecord>();
    for (const document of [...a, ...b]) {
      const prior = merged.get(document.id);
      if (!prior) { merged.set(document.id, { ...document }); continue; }
      const { created: pc, updated: pu, ...p } = prior;
      const { created: dc, updated: du, ...d } = document;
      // Never guess about paths, deletion, protection or user-controlled metadata.
      if (canonical(p) !== canonical(d)) return null;
      if ([pc, pu, dc, du].some(value => !Number.isFinite(Date.parse(value)))) return null;
      merged.set(document.id, { ...prior, created: Date.parse(pc) <= Date.parse(dc) ? pc : dc, updated: Date.parse(pu) >= Date.parse(du) ? pu : du });
    }
    return [...merged.values()];
  } catch { return null; }
}

async function candidates(directory: string): Promise<string[]> {
  const files = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  return ['documents.json', 'references.json', ...files.filter(name => name === 'events.json' || /^events\.[a-zA-Z0-9-]+\.json$/.test(name))];
}
async function inspect(directory: string, name: string): Promise<{ issue?: DataIssue; raw?: string; replacement?: string }> {
  const file = `agentNote/data/${name}`;
  let raw: string;
  try { raw = await fs.readFile(path.join(directory, name), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const replacement = name === 'documents.json' ? '[]\n' : name === 'references.json' ? '{}\n' : undefined;
      return { issue: { file, kind: 'missing', canRepair: replacement !== undefined }, replacement };
    }
    return { issue: { file, kind: 'unreadable', canRepair: false } };
  }
  try { if (valid(name, JSON.parse(raw))) return { raw }; } catch { /* Diagnose without changing data. */ }
  const conflict = /^<{7,}(?: |$)/m.test(raw);
  const merged = name === 'documents.json' && conflict ? mergeDocumentConflicts(raw) : null;
  return { raw, issue: { file, kind: conflict ? 'conflict' : 'invalid', canRepair: !!merged }, replacement: merged ? JSON.stringify(merged, null, 2) + '\n' : undefined };
}
export async function inspectData(directory: string): Promise<DataIssue[]> {
  const issues: DataIssue[] = [];
  for (const name of await candidates(directory)) { const result = await inspect(directory, name); if (result.issue) issues.push(result.issue); }
  return issues;
}
/** No reset-to-empty for damaged files. Back up exact bytes before publishing a repair. */
export async function repairData(directory: string): Promise<DataRepairResult> {
  await fs.mkdir(directory, { recursive: true });
  const result: DataRepairResult = { repaired: [], backups: [], remaining: [] };
  for (const name of await candidates(directory)) {
    const snapshot = await inspect(directory, name);
    if (!snapshot.issue || snapshot.replacement === undefined) continue;
    const file = path.join(directory, name);
    if (snapshot.raw === undefined) {
      try { await fs.writeFile(file, snapshot.replacement, { flag: 'wx' }); result.repaired.push(snapshot.issue.file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      continue;
    }
    const backupName = `${name}.${Date.now()}.${randomUUID()}.bak`;
    const backupDir = path.join(directory, 'repair-backups');
    await fs.mkdir(backupDir, { recursive: true });
    await fs.writeFile(path.join(backupDir, backupName), snapshot.raw, { flag: 'wx' });
    result.backups.push(`agentNote/data/repair-backups/${backupName}`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, snapshot.replacement, { flag: 'wx' });
      // Abort if Git sync or another writer changed the source since inspection.
      if (await fs.readFile(file, 'utf8') !== snapshot.raw) continue;
      await fs.rename(temporary, file);
      result.repaired.push(snapshot.issue.file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  result.remaining = await inspectData(directory);
  return result;
}
