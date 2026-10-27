/**
 * Helpers for the club and league PDFs in public/documents/<folder>/
 * (listed in src/data/documents.ts).
 */

export type DocumentFolder = 'gscc' | 'ncca';

export function documentUrl(folder: DocumentFolder, file: string, page?: number | null): string {
  return `/documents/${folder}/${encodeURIComponent(file)}${page ? `#page=${page}` : ''}`;
}

/** PDF page holding a character offset in extracted text (the last "[Page N]" marker before it). */
export function pageAt(text: string, index: number): number | null {
  let page: number | null = null;
  for (const match of text.matchAll(/\[Page (\d+)\]/g)) {
    if (match.index! > index) break;
    page = Number(match[1]);
  }
  return page;
}
