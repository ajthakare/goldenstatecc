/**
 * Unit Tests: /documents list and the Rules Assistant's extracted text stay in
 * step with the PDFs in public/documents/.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import { join } from 'path';
import { DOCUMENTS } from '../../src/data/documents';
import { documentUrl, pageAt } from '../../src/utils/documents';
import rules from '../../src/data/ncca-rules.json';

const DOCS_DIR = join(__dirname, '../../public/documents');
const pdfsIn = (folder: string) => readdirSync(join(DOCS_DIR, folder)).filter((f) => /\.pdf$/i.test(f)).sort();

describe('documents', () => {
  it.each(['gscc', 'ncca'] as const)('lists exactly the PDFs in public/documents/%s', (folder) => {
    const listed = DOCUMENTS.filter((d) => d.folder === folder).map((d) => d.file).sort();
    expect(listed).toEqual(pdfsIn(folder));
  });

  it('has extracted text for exactly the NCCA PDFs (re-run docs/scripts/extract-ncca-rules.py)', () => {
    expect(rules.documents.map((d) => d.file).sort()).toEqual(pdfsIn('ncca'));
    for (const doc of rules.documents) expect(doc.text).toContain('[Page 1]');
  });

  it('builds encoded links, with a page anchor when known', () => {
    expect(documentUrl('ncca', 'NCCA Code of Conduct.pdf')).toBe('/documents/ncca/NCCA%20Code%20of%20Conduct.pdf');
    expect(documentUrl('ncca', 'a.pdf', 4)).toBe('/documents/ncca/a.pdf#page=4');
  });
});

describe('formatAnswer', () => {
  it('numbers each quote once and links it to its document page', async () => {
    const { formatAnswer } = await import('../../netlify/functions/rules-ask');
    const i = rules.documents.findIndex((d) => d.file === 'NCCA Rain Impact Guidelines.pdf');
    const doc = rules.documents[i];
    const start = doc.text.indexOf('[Page 2]') + 10;
    const cite = {
      type: 'char_location' as const,
      cited_text: `${doc.text.slice(start, start + 40)}\n\n[Page 9]`,
      document_index: i,
      document_title: null,
      start_char_index: start,
      end_char_index: start + 40,
      file_id: null,
    };
    const text = (t: string, citations: any[] | null) => ({ type: 'text' as const, text: t, citations });

    const answer = formatAnswer([
      { type: 'thinking', thinking: '', signature: 'x' } as any,
      text('It is abandoned. ', null),
      text('The rule says so', [cite]),
      text(' and again', [cite]),
    ]);

    expect(answer.parts).toEqual([
      { text: 'It is abandoned. ', sources: [] },
      { text: 'The rule says so', sources: [1] },
      { text: ' and again', sources: [1] },
    ]);
    expect(answer.sources).toHaveLength(1);
    expect(answer.sources[0]).toMatchObject({
      title: 'NCCA Rain Impact Guidelines',
      page: 2,
      url: '/documents/ncca/NCCA%20Rain%20Impact%20Guidelines.pdf#page=2',
    });
    expect(answer.sources[0].quote).not.toMatch(/\[Page|\n/);
  });
});

describe('formatAnswer off-topic', () => {
  it('turns the off-topic marker into the fixed reply, with no sources', async () => {
    const { formatAnswer } = await import('../../netlify/functions/rules-ask');
    const answer = formatAnswer([
      { type: 'thinking', thinking: '', signature: 'x' } as any,
      { type: 'text', text: 'OUT_OF_SCOPE', citations: null },
    ]);
    expect(answer.sources).toEqual([]);
    expect(answer.parts).toHaveLength(1);
    expect(answer.parts[0].text).toMatch(/only answer questions about NCCA/);
  });
});

describe('pageAt', () => {
  const text = '[Page 1]\nalpha\n\n[Page 2]\nbeta\n\n[Page 3]\ngamma';

  it('finds the page a character offset falls on', () => {
    expect(pageAt(text, text.indexOf('alpha'))).toBe(1);
    expect(pageAt(text, text.indexOf('beta'))).toBe(2);
    expect(pageAt(text, text.indexOf('gamma'))).toBe(3);
  });

  it('counts a citation starting on a marker as that page', () => {
    expect(pageAt(text, text.indexOf('[Page 2]'))).toBe(2);
  });

  it('returns null before any marker', () => {
    expect(pageAt('no markers here', 3)).toBeNull();
  });
});
