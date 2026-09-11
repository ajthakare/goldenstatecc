import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isAdmin } from '../../src/middleware/auth';
import { SITE_CONFIG, isWinterCheckInAdminRestricted } from '../../src/config';
import {
  SUMMER_FEEDBACK_COLUMNS,
  type WinterCheckInResponse,
  type SummerFeedbackSummary,
} from '../../src/types/winter';

const wc = SITE_CONFIG.winterCheckIn;
const RESPONSES_KEY = `responses-${wc.seasonKey}`;

/**
 * Summer '26 feedback for the admin page — only records where the member said
 * they played, projected to identity + summer* fields, plus a summary.
 * GET /.netlify/functions/winter-checkin-summer-list
 * Requires: admin / super_admin session
 */
export const handler: Handler = async (
  event: HandlerEvent,
  _context: HandlerContext
) => {
  const session = validateAdminSession(event.headers.cookie);
  if (!session || !isAdmin(session) || isWinterCheckInAdminRestricted(session.email)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const store = getStore({
      name: 'winter-checkin',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const all =
      ((await store.get(RESPONSES_KEY, { type: 'json' })) as WinterCheckInResponse[]) || [];

    const rows = all
      .filter((r) => r.summerPlayed === 'yes')
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((r) => {
        const projected: Record<string, unknown> = { id: r.id };
        for (const { key } of SUMMER_FEEDBACK_COLUMNS) projected[key] = r[key];
        projected.summerLeadershipFeedback = r.summerLeadershipFeedback ?? {};
        return projected;
      });

    const summary: SummerFeedbackSummary = {
      total: rows.length,
      feltIncluded: { yes: 0, no: 0, 'at-times': 0 },
      notifiedBeforeXI: { yes: 0, no: 0, na: 0 },
      umpired: { yes: 0, no: 0 },
      byTeam: {},
    };
    for (const team of wc.summerFeedback?.teams ?? []) summary.byTeam[team] = 0;

    for (const r of rows) {
      const fi = r.summerFeltIncluded as keyof SummerFeedbackSummary['feltIncluded'] | undefined;
      if (fi && fi in summary.feltIncluded) summary.feltIncluded[fi] += 1;
      const nb = r.summerNotifiedBeforeXI as keyof SummerFeedbackSummary['notifiedBeforeXI'] | undefined;
      if (nb && nb in summary.notifiedBeforeXI) summary.notifiedBeforeXI[nb] += 1;
      const um = r.summerUmpired as keyof SummerFeedbackSummary['umpired'] | undefined;
      if (um && um in summary.umpired) summary.umpired[um] += 1;
      for (const team of (r.summerTeamsPlayedFor as string[] | undefined) ?? []) {
        summary.byTeam[team] = (summary.byTeam[team] || 0) + 1;
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        seasonLabel: wc.summerFeedback?.seasonLabel ?? 'Summer',
        teams: wc.summerFeedback?.teams ?? [],
        rows,
        summary,
      }),
    };
  } catch (error) {
    console.error('winter-checkin-summer-list error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
