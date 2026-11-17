export interface ExportControl {
  signal?: AbortSignal;
  onProgress?: (message: string, completed?: number, total?: number) => void;
  onWarning?: (name: string) => void;
}
export function checkExport(control?: ExportControl): void {
  if (control?.signal?.aborted) { const error = new Error("Export cancelled"); error.name = "AbortError"; throw error; }
}
export async function yieldExport(control?: ExportControl): Promise<void> {
  checkExport(control);
  await new Promise<void>(resolve => window.setTimeout(resolve, 0));
  checkExport(control);
}
export async function abortableExport<T>(pending: Promise<T>, control?: ExportControl): Promise<T> {
  if (!control?.signal) return pending;
  const signal = control.signal;
  let cancel: () => void = () => undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      cancel = () => { const error = new Error("Export cancelled"); error.name = "AbortError"; reject(error); };
      if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", cancel); }
}

/** Decode/resize large raster assets asynchronously before sending them to the PDF process. */
export async function compactExportImage(bytes: Uint8Array, mime: string, control?: ExportControl): Promise<Uint8Array> {
  checkExport(control);
  if (bytes.byteLength < 512 * 1024 || !/^image\/(?:png|jpeg|webp)$/.test(mime) || typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return bytes;
  let image: ImageBitmap;
  try { image = await createImageBitmap(new Blob([Uint8Array.from(bytes)], { type: mime })); }
  catch { checkExport(control); return bytes; }
  try {
    checkExport(control);
    const scale = Math.min(1, 2400 / Math.max(image.width, image.height));
    if (scale === 1) return bytes;
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
    const context = canvas.getContext("2d");
    if (!context) return bytes;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: mime, quality: 0.9 });
    checkExport(control);
    return new Uint8Array(await blob.arrayBuffer());
  } finally { image.close(); }
}
