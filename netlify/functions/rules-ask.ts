import { Handler, HandlerEvent } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import rules from '../../src/data/ncca-rules.json';
import { DOCUMENTS } from '../../src/data/documents';
import { documentUrl, pageAt } from '../../src/utils/documents';

/**
 * Rules Assistant: answers a rules question from the NCCA documents, with quotes.
 * POST /.netlify/functions/rules-ask
 * Body: { question: string, history?: { question: string, answer: string }[] }
 *   (history: the last few exchanges, so follow-ups like "what if it was a no-ball?" work)
 * Requires: admin
 * Returns: { parts: { text: string, sources: number[] }[], sources: Source[] }
 *
 * Every PDF in public/documents/ncca/ goes to Claude on every question (they fit
 * comfortably, so there's no search step to miss the right rule), with citations
 * on so each claim comes back tied to the exact text it quotes.
 * Needs ANTHROPIC_API_KEY; RULES_MODEL overrides the model.
 */

interface Source {
  title: string;
  page: number | null;
  url: string;
  quote: string;
}

const MODEL = process.env.RULES_MODEL || 'claude-haiku-5-5';
const MAX_QUESTION = 2000;
const MAX_HISTORY = 5;

const SYSTEM_PROMPT = `You help cricket captains and umpires settle rules questions during NCCA Winter T20 league matches, using only the NCCA documents provided. They are usually at the ground, reading on a phone, often mid-dispute.

Answer in this exact shape, in plain text (no markdown, no bold, no headings):
- First line: the ruling, in one short sentence of at most 20 words.
- Then one to three lines, each starting with "- ": one short sentence each naming a rule that supports the ruling, with its clause number and document (for example "ICC 28.7.4" or "Standing Rules 4.2.4"), cited from the document text.
- Add a line only for an exception that changes the outcome in this situation. Don't restate the question or the rule text: the quoted clauses are shown to the reader separately.

Decide every question in this order of precedence, which the Standing Rules preamble sets out:
1. NCCA Winter T20 Standing Rules first. If they have a provision covering the situation, it decides, even where the ICC playing conditions or MCC Laws say something different. When that happens, one point names the ICC clause it replaces.
2. ICC Men's T20 Playing Conditions decide everything the Standing Rules don't provide for. Don't add a point saying NCCA follows ICC; that's assumed.
3. The Code of Conduct (discipline) and the Rain Impact Guidelines (weather calls) apply in their own areas, but the Standing Rules prevail over them in any conflict or ambiguity. The Rain Impact Guidelines are guidance, not rules.
Only the NCCA Constitution sits above the Standing Rules, and it isn't provided: if a question turns on it, say so.
These documents cover the Winter T20 league only. If the question is about another league or format, say they may not apply.

If the documents don't cover the situation, say so in the first line. Anything you add from general cricket knowledge must be labelled as not from the NCCA documents.`;

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// Titles come from the documents list; fall back to the file name for a PDF not listed yet
const titleFor = (file: string) =>
  DOCUMENTS.find((d) => d.folder === 'ncca' && d.file === file)?.title || file.replace(/\.pdf$/i, '');

// The documents go first and never change between questions, so they're cached
// for an hour: a game-day burst of questions pays for them once
const documentBlocks: Anthropic.DocumentBlockParam[] = rules.documents.map((doc, i) => ({
  type: 'document',
  source: { type: 'text', media_type: 'text/plain', data: doc.text },
  title: titleFor(doc.file),
  citations: { enabled: true },
  ...(i === rules.documents.length - 1 ? { cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } } : {}),
}));

function promptFor(question: string, history: { question: string; answer: string }[]): string {
  if (!history.length) return question;
  const earlier = history
    .map((h) => `Question: ${h.question}\nYour answer: ${h.answer}`)
    .join('\n\n');
  return `Earlier in this conversation:\n\n${earlier}\n\nFollow-up question: ${question}`;
}

/** Answer text plus its numbered sources: each distinct quote once, in the order it's first cited. */
export function formatAnswer(content: Anthropic.ContentBlock[]): { parts: { text: string; sources: number[] }[]; sources: Source[] } {
  const sources: Source[] = [];
  const sourceKey = new Map<string, number>();
  const parts = content.flatMap((block) => {
    if (block.type !== 'text') return [];
    const refs = (block.citations || []).flatMap((c) => {
      if (c.type !== 'char_location') return [];
      const doc = rules.documents[c.document_index];
      if (!doc) return [];
      const key = `${c.document_index}:${c.start_char_index}`;
      if (!sourceKey.has(key)) {
        const page = pageAt(doc.text, c.start_char_index);
        sources.push({
          title: titleFor(doc.file),
          page,
          url: documentUrl('ncca', doc.file, page),
          quote: c.cited_text.replace(/\[Page \d+\]/g, ' ').replace(/\s+/g, ' ').trim(),
        });
        sourceKey.set(key, sources.length);
      }
      return [sourceKey.get(key)!];
    });
    return [{ text: block.text, sources: [...new Set(refs)] }];
  });
  return { parts, sources };
}

const asText = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export const handler: Handler = async (event: HandlerEvent) => {
  const session = validateAdminSession(event.headers.cookie);
  if (!session) return json(401, { error: 'Unauthorized' });
  // Admin endpoint: a valid member session isn't enough
  if (!(await isCurrentAdmin(session))) return json(403, { error: 'Admin access required' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!process.env.ANTHROPIC_API_KEY) return json(503, { error: 'The Rules Assistant is not set up yet.' });

  let body: any;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid request' });
  }
  const question = asText(body.question, MAX_QUESTION);
  if (!question) return json(400, { error: 'Ask a question first' });
  const history = (Array.isArray(body.history) ? body.history : [])
    .slice(-MAX_HISTORY)
    .map((h: any) => ({ question: asText(h?.question, MAX_QUESTION), answer: asText(h?.answer, 4000) }))
    .filter((h: { question: string; answer: string }) => h.question && h.answer);

  try {
    const client = new Anthropic({ maxRetries: 1 });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      // Low effort: finding and quoting a rule needs little deliberation, and it keeps
      // answers well inside the function time limit
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: [...documentBlocks, { type: 'text', text: promptFor(question, history) }] }],
    });

    // Token counts only (never the question) so the cost can be checked in the function log
    console.log('rules-ask usage', JSON.stringify({ model: response.model, ...response.usage }));

    if (response.stop_reason === 'refusal') {
      return json(200, { parts: [{ text: 'The assistant could not answer that question. Try rephrasing it.', sources: [] }], sources: [] });
    }

    return json(200, formatAnswer(response.content));
  } catch (error) {
    console.error('Rules Assistant error:', error);
    if (error instanceof Anthropic.RateLimitError) {
      return json(429, { error: 'The assistant is busy. Try again in a minute.' });
    }
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      return json(503, { error: 'The Rules Assistant is not set up correctly. Let the site admin know.' });
    }
    if (error instanceof Anthropic.BadRequestError && /credit|billing|spend/i.test(error.message)) {
      return json(503, { error: 'The Rules Assistant has used up this month’s budget.' });
    }
    return json(502, { error: 'The assistant could not answer right now. Try again.' });
  }
};
