import { Handler, HandlerEvent } from '@netlify/functions';
import { randomUUID } from 'crypto';
import Papa from 'papaparse';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import { purgeClubFeed } from './_profile-stats';
import { json, loadDuties, loadSeason, saveDuties } from './_umpiring';
import { importDutyRows } from '../../src/utils/umpiring';

/**
 * Import umpiring duties from the league schedule CSV (same columns as the
 * fixtures CSV). Only rows whose Umpiring Team is one of the season's teams
 * are kept, so the whole league sheet can be uploaded as-is. Upserts by Game#:
 * re-importing an updated schedule keeps umpire assignments and outcomes.
 * POST /.netlify/functions/umpiring-duties-import
 * Requires: admin
 * Body: { seasonId, csvData, dryRun? }  dryRun: preview counts without saving
 */
export const handler: Handler = async (event: HandlerEvent) => {
  try {
    const session = validateAdminSession(event.headers.cookie);
    if (!session) return json(401, { error: 'Unauthorized' });
    // Admin endpoint: a valid member session isn't enough
    if (!(await isCurrentAdmin(session))) return json(403, { error: 'Admin access required' });
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

    const { seasonId, csvData, dryRun } = JSON.parse(event.body || '{}');
    if (!seasonId || typeof csvData !== 'string' || !csvData.trim()) {
      return json(400, { error: 'seasonId and csvData are required' });
    }
    const season = await loadSeason(seasonId);
    if (!season) return json(404, { error: 'Season not found' });

    const parsed = Papa.parse<Record<string, string>>(csvData.replace(/^﻿/, ''), {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h: string) => h.trim(),
    });
    if (parsed.errors.length > 0) {
      return json(400, { error: 'Could not read the CSV', details: parsed.errors.slice(0, 5).map((e) => `Row ${(e.row ?? 0) + 2}: ${e.message}`) });
    }
    if (parsed.data.length === 0) return json(400, { error: 'CSV file is empty' });
    if (parsed.data.length > 2000) return json(400, { error: 'Cannot import more than 2000 rows at once' });

    const existing = await loadDuties(season.id, { strong: true });
    const result = importDutyRows(parsed.data, season, existing, {
      username: session.username,
      now: new Date().toISOString(),
      newId: randomUUID,
    });
    const { duties, ...summary } = result;

    if (!dryRun && (result.created > 0 || result.updated > 0)) {
      await saveDuties(season.id, duties);
      await purgeClubFeed();
      try {
        await addAuditLog(
          session.username,
          'umpiring_duty_import',
          `Imported umpiring duties: ${result.created} created, ${result.updated} updated`,
          season.id,
          { seasonId: season.id, ...summary, errors: summary.errors.length }
        );
      } catch (err) {
        console.error('Audit log failed:', err);
      }
    }

    return json(200, { success: true, dryRun: !!dryRun, ...summary });
  } catch (error) {
    console.error('Error importing umpiring duties:', error);
    return json(500, { error: 'Failed to import umpiring duties' });
  }
};
