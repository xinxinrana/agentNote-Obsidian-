import * as http from "http";
import { ActivityContext, CreateNodeInput, InsightEventType, StoreError, UpdateNodeInput, VaultStore } from "./store";
import { NodeType, qualityWarnings } from "./types";

export interface ServerOptions { port: number; host?: string; onActivity?: () => void }
const nodeView = (node: Awaited<ReturnType<VaultStore["getNode"]>>) => ({ ...node, warnings: qualityWarnings(node) });

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new StoreError(400, "请求体必须是合法 JSON"); }
}
function activityContext(req: http.IncomingMessage): ActivityContext {
  const decodeHeader = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
  const name = decodeHeader(req.headers["x-agentnote-agent-name"]?.toString() ?? req.headers["x-agentnote-agent"]?.toString() ?? "").trim().slice(0, 80);
  const sessionTitle = decodeHeader(req.headers["x-agentnote-session-title"]?.toString() ?? req.headers["x-agentnote-session"]?.toString() ?? "").trim().slice(0, 160);
  return name ? { actor: { name, sessionTitle: sessionTitle || undefined } } : {};
}

export class AgentServer {
  private server: http.Server | null = null;
  constructor(readonly store: VaultStore, private opts: ServerOptions) {}
  get port(): number | null { const address = this.server?.address(); return address && typeof address === "object" ? address.port : null; }
  async start(): Promise<number> {
    await this.store.init();
    this.server = http.createServer((req, res) => void this.handle(req, res).catch((error) => send(res, error instanceof StoreError ? error.statusCode : 500, { ok: false, error: error instanceof Error ? error.message : String(error) })));
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.opts.port, this.opts.host ?? "127.0.0.1", resolve); });
    return this.port!;
  }
  async stop(): Promise<void> { if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve())); this.server = null; }
  private shareLink(shareId: string): string { return `http://127.0.0.1:${this.port ?? this.opts.port}/api/shares/${shareId}/resolve`; }
  private notifyActivity(): void { try { this.opts.onActivity?.(); } catch { /* UI notifications never affect API responses */ } }
  private async withLink(node: Awaited<ReturnType<VaultStore["getNode"]>>, status: "created" | "updated", context: ActivityContext) {
    const share = await this.store.ensureShareForNode(node.id, context);
    return { status, link: this.shareLink(share.id), ...nodeView(node) };
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";
    if (url.pathname === "/api/health" && method === "GET") return send(res, 200, { ok: true, data: { status: "up", version: 2, vault: this.store.root } });
    if (parts[0] !== "api") return send(res, 404, { ok: false, error: "接口不存在" });
    const context = activityContext(req);

    if (parts[1] === "nodes" && parts.length === 2) {
      if (method === "GET") return send(res, 200, { ok: true, data: (await this.store.listNodes({ q: url.searchParams.get("q") ?? undefined, type: url.searchParams.get("type") as NodeType ?? undefined, archived: url.searchParams.has("archived") ? url.searchParams.get("archived") === "true" : undefined })).map(nodeView) });
      if (method === "POST") {
        const body = await readBody(req) as CreateNodeInput;
        const idempotencyKey = req.headers["idempotency-key"]?.toString() ?? body.idempotencyKey;
        const node = await this.store.createNode(body, idempotencyKey, context);
        this.notifyActivity();
        return send(res, 201, { ok: true, data: await this.withLink(node, "created", context) });
      }
    }
    if (parts[1] === "nodes" && parts.length === 3) {
      const id = parts[2];
      if (method === "GET") return send(res, 200, { ok: true, data: nodeView(await this.store.getNode(id)) });
      if (method === "PUT" || method === "PATCH") {
        const node = await this.store.updateNode(id, await readBody(req) as UpdateNodeInput, context);
        this.notifyActivity();
        return send(res, 200, { ok: true, data: await this.withLink(node, "updated", context) });
      }
    }
    if (parts[1] === "nodes" && parts.length === 4 && parts[3] === "archive" && method === "POST") {
      const body = await readBody(req) as { archived?: boolean };
      const node = await this.store.archiveNode(parts[2], body.archived !== false, context);
      this.notifyActivity();
      return send(res, 200, { ok: true, data: nodeView(node) });
    }
    if (parts[1] === "shares" && parts.length === 2 && method === "POST") {
      const body = await readBody(req) as { nodeId?: string; path?: string; background?: string; selection?: string };
      if (body.nodeId) return send(res, 201, { ok: true, data: await this.store.createShare(body.nodeId, body.selection, context) });
      if (body.path) return send(res, 201, { ok: true, data: await this.store.createPathShare(body.path, body.background, body.selection, context) });
      throw new StoreError(400, "nodeId 或 path 至少提供一个");
    }
    if (parts[1] === "shares" && parts.length === 4 && parts[3] === "resolve" && method === "GET") {
      const data = await this.store.resolveShare(parts[2], context);
      this.notifyActivity();
      if (url.searchParams.get("raw") === "1") {
        const text = data.kind === "folder" ? data.entries.join("\n") : data.content;
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(text) });
        return void res.end(text);
      }
      return send(res, 200, { ok: true, data });
    }
    if (parts[1] === "insights" && method === "GET") {
      if (parts[2] === "overview") return send(res, 200, { ok: true, data: await this.store.getDashboardInsights() });
      if (parts[2] === "activity") return send(res, 200, { ok: true, data: await this.store.listActivity({ from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined, agent: url.searchParams.get("agent") ?? undefined, action: url.searchParams.get("action") as InsightEventType ?? undefined, nodeId: url.searchParams.get("nodeId") ?? undefined }) });
      if (parts[2] === "agents") return send(res, 200, { ok: true, data: await this.store.getAgentInsights() });
      if (parts[2] === "documents") return send(res, 200, { ok: true, data: await this.store.getDocumentInsights() });
    }
    return send(res, 404, { ok: false, error: `没有这条路由: ${method} ${url.pathname}` });
  }
}
function send(res: http.ServerResponse, status: number, payload: unknown): void { const body = JSON.stringify(payload, null, 2); res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) }); res.end(body); }
