/**
 * 插件性能探针（默认关闭）。
 *
 * 用法：在 Obsidian 控制台执行 `localStorage.setItem("agentnote:perf", "1")` 后重载插件，
 * 再用 `__anPerf.report()` 打印汇总、`__anPerf.microbench("标签", fn)` 做单次对照。
 * 取消时 `localStorage.removeItem("agentnote:perf")`。
 */

interface Sample { label: string; ms: number; at: number }
interface HeapPoint { at: number; heap: number; dom: number }

const samples: Sample[] = [];
const heapTrack: HeapPoint[] = [];
const MAX = 4000;

/** 包装一个方法，记录每次调用的耗时。返回值透传。 */
export function instrument<T extends object, K extends keyof T & string>(
  target: T,
  method: K,
  label = `${target.constructor.name}.${String(method)}`,
): () => void {
  const original = target[method] as unknown as (...args: unknown[]) => unknown;
  if (typeof original !== "function") throw new Error(`${label} 不是方法`);
  // 保留原函数的 this 绑定语义
  (target as Record<string, unknown>)[method] = function (this: unknown, ...args: unknown[]) {
    const t0 = performance.now();
    try {
      const out = original.apply(this, args);
      // 异步方法要把耗时记到 Promise 完成时
      if (out && typeof (out as Promise<unknown>).then === "function") {
        return (out as Promise<unknown>).finally(() => record(label, performance.now() - t0));
      }
      record(label, performance.now() - t0);
      return out;
    } catch (error) {
      record(label, performance.now() - t0);
      throw error;
    }
  };
  return () => { (target as Record<string, unknown>)[method] = original; };
}

function record(label: string, ms: number): void {
  if (samples.length >= MAX) samples.shift();
  samples.push({ label, ms, at: Date.now() });
}

/** 统计一组数字的分位数。 */
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  return {
    count: sorted.length,
    total: sorted.reduce((a, b) => a + b, 0),
    avg: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
    p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1),
  };
}

/** 汇总报告，按总耗时降序。 */
export function report(): void {
  const byLabel = new Map<string, number[]>();
  for (const s of samples) {
    const list = byLabel.get(s.label) ?? [];
    list.push(s.ms);
    byLabel.set(s.label, list);
  }
  const rows = [...byLabel.entries()]
    .map(([label, values]) => ({ label, ...stats(values) }))
    .sort((a, b) => b.total - a.total);

  console.log(`%c[agentNote perf] ${samples.length} 次采样`, "font-weight:bold;font-size:13px");
  console.table(rows.map((r) => ({
    方法: r.label,
    次数: r.count,
    总耗时ms: +r.total.toFixed(1),
    平均ms: +r.avg.toFixed(2),
    p50: +r.p50.toFixed(2),
    p95: +r.p95.toFixed(2),
    最大ms: +r.max.toFixed(2),
  })));

  if (heapTrack.length) {
    const first = heapTrack[0], last = heapTrack.at(-1)!;
    console.log(`%c[内存] heapUsed ${mib(first.heap)} → ${mib(last.heap)} MB (Δ ${mib(last.heap - first.heap)} MB)`,
      "font-weight:bold");
    console.log(`        DOM 节点 ${first.dom} → ${last.dom} (Δ ${last.dom - first.dom})`);
    console.table(heapTrack.map((p) => ({
      时间: new Date(p.at).toLocaleTimeString(),
      "heap MB": +mib(p.heap),
      "DOM 节点": p.dom,
    })));
  }
}

const mib = (bytes: number) => bytes / 1048576;

/** 采样堆内存和 DOM 节点数，默认每 10 秒一次。返回停止函数。 */
export function startHeapTracking(intervalMs = 10_000): () => void {
  const take = () => {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    heapTrack.push({
      at: Date.now(),
      heap: mem?.usedJSHeapSize ?? 0,
      // 只数内容区，避免把 Obsidian 自身的 DOM 算进去
      dom: document.querySelectorAll("body *").length,
    });
    if (heapTrack.length > 720) heapTrack.shift(); // 2 小时
  };
  take();
  const timer = window.setInterval(take, intervalMs);
  return () => window.clearInterval(timer);
}

/** 单次计时，用于 A/B 对比。 */
export async function profile<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
  const t0 = performance.now();
  try { return await fn(); }
  finally { record(label, performance.now() - t0); }
}

/** 一轮「刷新 10 次」的微基准，适合在控制台直接跑。 */
export async function microbench(label: string, fn: () => unknown, rounds = 10): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  const s = stats(times);
  console.log(`%c${label}`, "font-weight:bold",
    `\n  中位 ${s.p50.toFixed(1)}ms  p95 ${s.p95.toFixed(1)}ms  最大 ${s.max.toFixed(1)}ms`,
    `\n  全部: ${times.map((t) => t.toFixed(1)).join(", ")}`);
  return times;
}

/** 清空采样。 */
export function reset(): void { samples.length = 0; heapTrack.length = 0; }

/**
 * 挂到 window 上，方便在 DevTools 控制台直接调用。
 * 传入插件实例即可自动包装几个关键入口。
 */
export function installPerfProbe(plugin: { store?: object }): () => void {
  const undo: (() => void)[] = [];
  const store = plugin.store as Record<string, unknown> | undefined;
  if (store) {
    for (const method of ["getDashboardInsights", "listNodes", "recordDocumentReferences"]) {
      if (typeof store[method] === "function") undo.push(instrument(store, method));
    }
  }
  const stopHeap = startHeapTracking();

  (window as unknown as Record<string, unknown>).__anPerf = {
    report, reset, profile, microbench, startHeapTracking,
    raw: () => samples,
  };
  console.log("%c[agentNote perf] 探针已安装 → __anPerf.report()", "color:#2c7;font-weight:bold");
  return () => { undo.forEach((f) => f()); stopHeap(); };
}
