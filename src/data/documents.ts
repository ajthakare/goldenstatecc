/**
 * Documents shown on /documents. The PDFs live in public/documents/<folder>/;
 * to add one, drop the PDF in the folder and add an entry here
 * (tests/unit/ncca-rules.test.ts checks the two match).
 *
 * PDFs in ncca/ are also what the admin Rules Assistant answers from: after
 * changing that folder, re-run docs/scripts/extract-ncca-rules.py.
 */
import type { DocumentFolder } from '../utils/documents';

export interface ClubDocument {
  folder: DocumentFolder;
  file: string;
  title: string;
  description: string;
}

/** NCCA's own documents page, where the latest versions are published. */
export const NCCA_DOCUMENTS_URL = 'https://www.nccacricket.org/NCCA/documents';

export const DOCUMENTS: ClubDocument[] = [
  {
    folder: 'gscc',
    file: 'Anthony_One_Ground_Regulations.pdf',
    title: 'Anthony One Ground Regulations',
    description: 'Arrival, parking, team area and ground rules for our home ground at Ochoa Middle School, Hayward.',
  },
  {
    folder: 'gscc',
    file: 'How to Install the GSCC App.pdf',
    title: 'How to Install the GSCC App',
    description: 'Add the GSCC app to your iPhone home screen from Safari or Chrome. No App Store needed.',
  },
  {
    folder: 'ncca',
    file: '2026 NCCA Winter T20 Standing Rules - Oct 26 2026.docx.pdf',
    title: 'NCCA Winter T20 Standing Rules 2026',
    description: 'League playing conditions for the winter T20 season (updated Oct 26, 2026).',
  },
  {
    folder: 'ncca',
    file: 'ICC Mens T20 Playing Conditions - October 2026.pdf',
    title: 'ICC Men’s T20 Playing Conditions',
    description: 'The ICC playing conditions the Standing Rules build on (October 2026 edition).',
  },
  {
    folder: 'ncca',
    file: 'NCCA Code of Conduct.pdf',
    title: 'NCCA Code of Conduct',
    description: 'Conduct rules that bind every participant in NCCA matches, and how the Disciplinary Committee handles breaches.',
  },
  {
    folder: 'ncca',
    file: 'NCCA Rain Impact Guidelines.pdf',
    title: 'NCCA Rain Impact Guidelines',
    description: 'How weather and ground conditions decide whether a match goes ahead.',
  },
];
