import { t } from "../i18n";
import * as fsp from "fs/promises";
import { constants } from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomUUID } from "crypto";
import type { InsightEvent } from "./store";

export interface ActivityLogOptions {
  /** Kept outside the vault so cloning a vault does not clone its writer identity. */
  deviceIdFile?: string;
  referencesFile?: string;
}

const devicePattern = /^[a-zA-Z0-9-]{1,80}$/;
export interface ActivityReadIssue { file: string; message: string }
export interface ActivityReadResult { events: InsightEvent[]; issues: ActivityReadIssue[] }
type CachedSource = { mtimeMs: number; ctimeMs: number; size: number; events?: InsightEvent[]; issue?: string };
export function isLocalActivityBurst(events: readonly { type: string; at: number }[]): boolean {
  for (let end = 0, start = 0; end < events.length; end++) {
    while (events[end].at - events[start].at >= 1_000) start++;
    if (end - start + 1 > 10) return true;
    let same = 0;
    for (let index = start; index <= end; index++) if (events[index].type === events[end].type) same++;
    if (same > 3) return true;
  }
  return false;
}
function isEvent(value: unknown): value is InsightEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as InsightEvent;
  return typeof event.at === "string" && Number.isFinite(Date.parse(event.at)) && typeof event.type === "string"
    && (event.eventId === undefined || (typeof event.eventId === "string" && !!event.eventId))
    && (event.deviceId === undefined || (typeof event.deviceId === "string" && devicePattern.test(event.deviceId)));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export class ActivityLog {
  private identity: Promise<string> | null = null;
  private readonly deviceIdFile: string;
  private sourceCache = new Map<string, CachedSource>();
  constructor(private directory: string, options: ActivityLogOptions = {}) {
    this.deviceIdFile = options.deviceIdFile ?? path.join(os.homedir(), ".agentnote", "device-id");
  }
  private async loadDeviceId(): Promise<string> {
    await fsp.mkdir(path.dirname(this.deviceIdFile), { recursive: true });
    try { await fsp.access(this.deviceIdFile); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = `${this.deviceIdFile}.${randomUUID()}.tmp`;
      try {
        await fsp.writeFile(temporary, randomUUID(), { flag: "wx", mode: 0o600 });
        // Publish a complete identity without overwriting a concurrently created one.
        try { await fsp.link(temporary, this.deviceIdFile); }
        catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") throw linkError; }
      } finally { await fsp.rm(temporary, { force: true }); }
    }
    const id = (await fsp.readFile(this.deviceIdFile, "utf8")).trim();
    if (!devicePattern.test(id)) throw new Error(t("agentNote 本机设备 ID 无效，请检查本机 device-id 文件。"));
    return id;
  }
  private deviceId(): Promise<string> {
    if (!this.identity) this.identity = this.loadDeviceId().catch((error) => { this.identity = null; throw error; });
    return this.identity;
  }
  async init(): Promise<void> { await this.deviceId(); }
  async filePath(): Promise<string> { return path.join(this.directory, `events.${await this.deviceId()}.json`); }
  private async readFile(file: string, missingAllowed = false): Promise<InsightEvent[]> {
    let raw: string;
    try { raw = await fsp.readFile(file, "utf8"); }
    catch (error) { if (missingAllowed && (error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    let value: unknown;
    try { value = JSON.parse(raw) as unknown; }
    catch { throw new Error(t("活动日志不是合法 JSON：{0}", path.basename(file))); }
    if (file.includes(`${path.sep}events${path.sep}`)) {
      if (!isEvent(value) || value.eventId !== path.basename(file, ".json")) throw new Error(t("活动日志格式无效：{0}", path.basename(file)));
      return [value];
    }
    if (!Array.isArray(value) || !value.every(isEvent)) throw new Error(t("活动日志格式无效：{0}", path.basename(file)));
    return value;
  }
  private async sourceFiles(issues: ActivityReadIssue[] = []): Promise<string[]> {
    const legacy = (await fsp.readdir(this.directory).catch((error: NodeJS.ErrnoException) => { issues.push({ file: this.directory, message: error.message }); return []; })).filter((name) => name === "events.json" || /^events\.[a-zA-Z0-9-]+\.json$/.test(name));
    const eventDirectory = path.join(this.directory, "events");
    const months = await fsp.readdir(eventDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      issues.push({ file: "events", message: error.message });
      return [];
    });
    const independent: string[] = [];
    for (const month of months) {
      if (!month.isDirectory() || !/^\d{4}-\d{2}$/.test(month.name)) continue;
      const names = await fsp.readdir(path.join(eventDirectory, month.name)).catch((error: NodeJS.ErrnoException) => { issues.push({ file: path.join("events", month.name), message: error.message }); return []; });
      for (const name of names) {
        if (/^[a-f0-9-]{36}\.json$/i.test(name)) independent.push(path.join("events", month.name, name));
      }
    }
    return [...legacy, ...independent].sort();
  }
  async readReport(): Promise<ActivityReadResult> {
    const issues: ActivityReadIssue[] = [];
    const files = await this.sourceFiles(issues);
    const sourceSet = new Set(files);
    for (const file of this.sourceCache.keys()) if (!sourceSet.has(file)) this.sourceCache.delete(file);
    const seen = new Map<string, string>();
    const result: InsightEvent[] = [];
    const conflicted = new Set<string>();
    for (let offset = 0; offset < files.length; offset += 64) {
      const batch = files.slice(offset, offset + 64);
      const sources = await Promise.all(batch.map(async (file): Promise<CachedSource> => {
        try {
          const source = path.join(this.directory, file);
          const stat = await fsp.stat(source);
          const cached = this.sourceCache.get(file);
          if (cached?.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs && cached.size === stat.size) return cached;
          const entry = { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, events: await this.readFile(source) };
          this.sourceCache.set(file, entry);
          return entry;
        } catch (error) {
          const entry = { mtimeMs: -1, ctimeMs: -1, size: -1, issue: error instanceof Error ? error.message : String(error) };
          this.sourceCache.set(file, entry);
          return entry;
        }
      }));
      for (const [index, source] of sources.entries()) {
        const file = batch[index];
        if (source.issue) { issues.push({ file, message: source.issue }); continue; }
        const occurrences = new Map<string, number>();
        for (const event of source.events ?? []) {
          let eventId = event.eventId;
          if (!eventId) {
            const hash = createHash("sha256").update(canonical(event)).digest("hex");
            const occurrence = occurrences.get(hash) ?? 0;
            occurrences.set(hash, occurrence + 1);
            eventId = `legacy-${hash}-${occurrence}`;
          }
          const signature = canonical(Object.fromEntries(Object.entries(event).filter(([key]) => key !== "eventId")));
          const previous = seen.get(eventId);
          if (previous !== undefined) {
            if (previous !== signature) { issues.push({ file, message: t("活动记录 ID 重复且内容不同：{0}", eventId) }); conflicted.add(eventId); }
            continue;
          }
          seen.set(eventId, signature);
          result.push({ ...event, eventId });
        }
      }
    }
    return { events: result.filter((event) => !conflicted.has(event.eventId!)).sort((a, b) => a.at.localeCompare(b.at) || a.eventId!.localeCompare(b.eventId!)), issues };
  }
  async read(): Promise<InsightEvent[]> { return (await this.readReport()).events; }
  async backupPastDays(now = new Date()): Promise<{ created: number; existing: number }> {
    const dayKey = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const today = dayKey(now);
    const deviceId = await this.deviceId();
    const sources = [{ file: "events.json", label: `legacy.${deviceId}` }, { file: `events.${deviceId}.json`, label: deviceId }];
    const snapshots: { day: string; name: string; events: InsightEvent[] }[] = [];
    for (const source of sources) {
      const days = new Map<string, InsightEvent[]>();
      let sourceEvents: InsightEvent[];
      try { sourceEvents = await this.readFile(path.join(this.directory, source.file), true); }
      catch { continue; }
      for (const event of sourceEvents) {
        const date = new Date(event.at);
        const day = dayKey(date);
        if (day >= today) continue;
        const events = days.get(day) ?? [];
        events.push(event);
        days.set(day, events);
      }
      for (const [day, events] of days) snapshots.push({ day, name: `events.${source.label}.${day}.json`, events });
    }
    snapshots.sort((left, right) => left.day.localeCompare(right.day) || left.name.localeCompare(right.name));
    const directory = path.join(this.directory, "cold-backups");
    let created = 0;
    let existing = 0;
    if (snapshots.length) await fsp.mkdir(directory, { recursive: true });
    for (const snapshot of snapshots) {
      const target = path.join(directory, snapshot.name);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await fsp.writeFile(temporary, JSON.stringify(snapshot.events, null, 2), { flag: "wx" });
        try { await fsp.link(temporary, target); created++; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") existing++; else throw error; }
      } finally { await fsp.rm(temporary, { force: true }); }
    }
    const deviceDirectory = path.join(directory, "immutable");
    for (const file of await this.sourceFiles()) {
      if (!file.startsWith(`events${path.sep}`)) continue;
      let events: InsightEvent[];
      try { events = await this.readFile(path.join(this.directory, file)); }
      catch { continue; }
      if (events.length !== 1 || events[0].deviceId !== deviceId) continue;
      const at = new Date(events[0].at);
      if (!Number.isFinite(at.getTime()) || dayKey(at) >= today) continue;
      const target = path.join(deviceDirectory, path.basename(file));
      await fsp.mkdir(deviceDirectory, { recursive: true });
      try { await fsp.copyFile(path.join(this.directory, file), target, constants.COPYFILE_EXCL); created++; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") existing++; else throw error; }
    }
    return { created, existing };
  }
  async append(event: Omit<InsightEvent, "at" | "eventId" | "deviceId">): Promise<void> {
    const deviceId = await this.deviceId();
    const at = new Date().toISOString();
    const eventId = randomUUID();
    const directory = path.join(this.directory, "events", at.slice(0, 7));
    const file = path.join(directory, `${eventId}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fsp.mkdir(directory, { recursive: true });
    try {
      await fsp.writeFile(temporary, JSON.stringify({ ...event, at, eventId, deviceId }, null, 2), { flag: "wx" });
      await fsp.link(temporary, file);
    } finally { await fsp.rm(temporary, { force: true }); }
  }
}
