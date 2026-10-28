/** Offsets count UTF-16 code units, matching Obsidian's editor and JS strings. */
export interface SelectionMetadata {
  scope: "selection";
  isCompleteDocument: boolean;
  selectedLength: number;
  sourceLength: number;
  coverage: number;
  offsetUnit: "utf16";
  position: { status: "exact"; startOffset: number; endOffset: number; startLine: number; endLine: number } | { status: "ambiguous" };
}

/** Live Preview renders some Markdown (tables, wiki links, embeds) differently from its source,
 *  so the selected text may not exist verbatim in the file. Editor offsets always do. */
export function selectionSnippet(source: string, selection: string, startOffset?: number, endOffset?: number): string {
  if (selection && source.includes(selection)) return selection;
  if (startOffset === undefined || endOffset === undefined) return selection;
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) return selection;
  if (startOffset < 0 || endOffset <= startOffset || endOffset > source.length) return selection;
  return source.slice(startOffset, endOffset);
}

export function selectionMetadata(source: string, selection: string, preferredStart?: number): SelectionMetadata {
  const first = source.indexOf(selection);
  const start = Number.isInteger(preferredStart) && preferredStart! >= 0 && source.slice(preferredStart, preferredStart! + selection.length) === selection
    ? preferredStart! : first >= 0 && source.indexOf(selection, first + 1) < 0 ? first : undefined;
  return {
    scope: "selection", isCompleteDocument: source === selection,
    selectedLength: selection.length, sourceLength: source.length,
    coverage: source.length ? selection.length / source.length : 1, offsetUnit: "utf16",
    position: start === undefined ? { status: "ambiguous" } : {
      status: "exact", startOffset: start, endOffset: start + selection.length,
      startLine: source.slice(0, start).split("\n").length,
      endLine: source.slice(0, start + Math.max(0, selection.length - 1)).split("\n").length,
    },
  };
}
