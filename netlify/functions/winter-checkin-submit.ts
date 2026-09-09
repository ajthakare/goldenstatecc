import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession, isMember } from '../../src/middleware/auth';
import { addAuditLog } from '../../src/utils/auditLog';
import { SITE_CONFIG } from '../../src/config';
import type { Player } from '../../src/types/player';
import type { WinterCheckInResponse } from '../../src/types/winter';

const wc = SITE_CONFIG.winterCheckIn;
const RESPONSES_KEY = `responses-${wc.seasonKey}`;

const PARTICIPATION = ['in', 'out', 'transfer', 'enquiring'];
const WEEKEND_FREQ = ['most', 'half', 'occasional'];
const COMMITMENT = ['full-time', 'part-time'];
const LEADERSHIP = ['captain', 'vice-captain', 'none'];
const EMPLOYMENT = ['employed', 'student'];
const JERSEY_SIZE = ['S', 'M', 'L', 'XL', 'XXL'];
const SUMMER_FELT = ['yes', 'no', 'at-times'];
const SUMMER_NOTIFIED = ['yes', 'no', 'na'];
const SUMMER_YESNO = ['yes', 'no'];
const SUMMER_TEAMS: string[] = wc.summerFeedback?.teams ?? [];
const summerSlug = (team: string) => team.replace(/[^A-Za-z0-9]/g, '');
const SUMMER_TEAM_SLUGS = new Set(SUMMER_TEAMS.map(summerSlug));
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getResponsesStore() {
  return getStore({
    name: 'winter-checkin',
    siteID: process.env.SITE_ID || '',
    token: process.env.NETLIFY_AUTH_TOKEN || '',
  });
}

function getPlayersStore() {
  return getStore({
    name: 'players',
    siteID: process.env.SITE_ID || '',
    token: process.env.NETLIFY_AUTH_TOKEN || '',
  });
}

const str = (v: unknown, max = 200): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

const strOrUndef = (v: unknown, max = 200): string | undefined => {
  const s = str(v, max);
  return s === '' ? undefined : s;
};

const oneOf = (v: unknown, allowed: string[]): string | undefined => {
  const s = str(v);
  return allowed.includes(s) ? s : undefined;
};

const strArray = (v: unknown, max = 40): string[] => {
  const raw = Array.isArray(v) ? v : v == null || v === '' ? [] : [v];
  return raw
    .map((x) => str(x, max))
    .filter((x) => x !== '')
    .slice(0, 50);
};

export const handler: Handler = async (
  event: HandlerEvent,
  _context: HandlerContext
) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!wc.acceptingResponses) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: 'The winter check-in is closed.' }),
    };
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  // Honeypot — bots fill hidden fields. Pretend success, store nothing.
  if (str(body.company_website) !== '') {
    return { statusCode: 200, body: JSON.stringify({ success: true, updated: false }) };
  }

  const errors: string[] = [];

  // --- Identity: from the player record for members, from the body for guests ---
  const session = validateAdminSession(event.headers.cookie);
  const memberSession = session && isMember(session) ? session : null;

  let players: Player[] = [];
  let playerRecord: Player | undefined;
  const playersStore = getPlayersStore();

  if (memberSession) {
    players = ((await playersStore.get('players-all', { type: 'json' })) as Player[]) || [];
    playerRecord = players.find((p) => p.id === memberSession.userId);
    if (!playerRecord) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Member record not found' }) };
    }
  }

  const firstName = memberSession
    ? str(playerRecord!.firstName, 100)
    : str(body.firstName, 100);
  const lastName = memberSession
    ? str(playerRecord!.lastName, 100)
    : str(body.lastName, 100);
  const email = memberSession
    ? str(playerRecord!.email, 200).toLowerCase()
    : str(body.email, 200).toLowerCase();
  const phone = memberSession
    ? str(playerRecord!.phone, 40)
    : str(body.phone, 40);

  if (!memberSession) {
    if (!firstName) errors.push('First name is required.');
    if (!lastName) errors.push('Last name is required.');
    if (!email) errors.push('Email is required.');
    else if (!EMAIL_RE.test(email)) errors.push('Email looks invalid.');
    if (!phone) errors.push('Mobile number is required.');
  }

  // --- Participation ---
  const participation = oneOf(body.participation, PARTICIPATION);
  if (!participation) errors.push('Tell us whether you want to play this winter.');
  // "enquiring" is a guest-only state.
  if (participation === 'enquiring' && memberSession) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid participation value for a member.' }),
    };
  }
  const playing = participation === 'in';

  const emergencyContactName = str(body.emergencyContactName, 100);
  const emergencyContactNumber = str(body.emergencyContactNumber, 40);
  const weekendFrequency = oneOf(body.weekendFrequency, WEEKEND_FREQ);
  const availabilityCommitment = oneOf(body.availabilityCommitment, COMMITMENT);
  const nccaRaw = str(body.nccaUmpireCertified);
  const goals = str(body.goals, 2000);
  const membershipAcknowledged =
    str(body.membershipAcknowledged) === 'yes' || body.membershipAcknowledged === true;
  const liabilityAccepted =
    str(body.liabilityAccepted) === 'yes' || body.liabilityAccepted === true;

  // The full question set only applies when they're actually playing.
  if (playing) {
    if (!emergencyContactName) errors.push('Emergency contact name is required.');
    if (!emergencyContactNumber) errors.push('Emergency contact phone is required.');
    if (!weekendFrequency) errors.push('Tell us roughly how many weekends you can make.');
    if (!availabilityCommitment) errors.push('Let us know if you’re full-time or part-time.');
    if (nccaRaw !== 'yes' && nccaRaw !== 'no') {
      errors.push('Let us know your NCCA umpiring status.');
    }
    if (!goals) errors.push('Tell us what you want out of the season.');
    if (!liabilityAccepted) {
      errors.push('Please confirm you take part of your own free will and at your own risk.');
    }
    if (!memberSession && !membershipAcknowledged) {
      errors.push('Please confirm you understand what joining involves.');
    }
  }

  // --- Summer '26 feedback (members only) ---
  const summerPlayed = memberSession ? oneOf(body.summerPlayed, SUMMER_YESNO) : undefined;
  if (memberSession && !summerPlayed) {
    errors.push('Let us know whether you played with us this summer.');
  }

  // Parse per-team captain / vice-captain feedback, keep only real teams.
  const rawLeadership =
    body.summerLeadershipFeedback && typeof body.summerLeadershipFeedback === 'object'
      ? (body.summerLeadershipFeedback as Record<string, unknown>)
      : {};
  const summerLeadershipFeedback: Record<string, { captain?: string; viceCaptain?: string }> = {};
  for (const [slug, raw] of Object.entries(rawLeadership)) {
    if (!SUMMER_TEAM_SLUGS.has(slug) || !raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const captain = strOrUndef(entry.captain, 2000);
    const viceCaptain = strOrUndef(entry.viceCaptain, 2000);
    if (captain || viceCaptain) summerLeadershipFeedback[slug] = { captain, viceCaptain };
  }

  const summerFeltIncluded = oneOf(body.summerFeltIncluded, SUMMER_FELT);
  const summerExperienceNotes = strOrUndef(body.summerExperienceNotes, 2000);
  const summerTeamsPlayedFor = strArray(body.summerTeamsPlayedFor, 40).filter((t) =>
    SUMMER_TEAMS.includes(t)
  );
  const summerNotifiedBeforeXI = oneOf(body.summerNotifiedBeforeXI, SUMMER_NOTIFIED);
  const summerUmpired = oneOf(body.summerUmpired, SUMMER_YESNO);
  const summerTeamImprovement = strOrUndef(body.summerTeamImprovement, 2000);
  const summerTeamSuggestions = strOrUndef(body.summerTeamSuggestions, 2000);
  const summerPracticeNotes = strOrUndef(body.summerPracticeNotes, 2000);
  const summerJerseyNotes = strOrUndef(body.summerJerseyNotes, 2000);
  const summerOther = strOrUndef(body.summerOther, 2000);

  // Every summer field is mandatory once a member says they played.
  if (memberSession && summerPlayed === 'yes') {
    const need = 'Every field in the summer feedback section is required.';
    if (!summerFeltIncluded) errors.push(need);
    if (!summerExperienceNotes) errors.push(need);
    if (summerTeamsPlayedFor.length === 0) errors.push('Pick at least one summer team.');
    if (!summerNotifiedBeforeXI) errors.push(need);
    if (!summerUmpired) errors.push(need);
    if (!summerTeamImprovement) errors.push(need);
    if (!summerTeamSuggestions) errors.push(need);
    if (!summerPracticeNotes) errors.push(need);
    if (!summerJerseyNotes) errors.push(need);
    if (!summerOther) errors.push(need);
    for (const team of summerTeamsPlayedFor) {
      const fb = summerLeadershipFeedback[summerSlug(team)];
      if (!fb?.captain) errors.push(`Add feedback for the ${team} captain.`);
      if (!fb?.viceCaptain) errors.push(`Add feedback for the ${team} vice-captain.`);
    }
  }

  // --- Optional / bounded fields ---
  const awayFrom = strOrUndef(body.awayFrom, 10);
  const awayTo = strOrUndef(body.awayTo, 10);
  if (awayFrom && !ISO_DATE.test(awayFrom)) errors.push('“Away from” is not a valid date.');
  if (awayTo && !ISO_DATE.test(awayTo)) errors.push('“Away until” is not a valid date.');
  if (awayFrom && awayTo && awayTo < awayFrom) {
    errors.push('“Away until” can’t be before “away from”.');
  }

  if (errors.length > 0) {
    const unique = Array.from(new Set(errors));
    return { statusCode: 400, body: JSON.stringify({ error: unique.join(' '), errors: unique }) };
  }

  const now = new Date().toISOString();
  const store = getResponsesStore();
  const all = ((await store.get(RESPONSES_KEY, { type: 'json' })) as WinterCheckInResponse[]) || [];

  const existingIndex = all.findIndex((r) =>
    memberSession
      ? r.playerId === memberSession.userId
      : r.submittedVia === 'guest' && r.email.toLowerCase() === email
  );
  const existing = existingIndex >= 0 ? all[existingIndex] : undefined;

  const record: WinterCheckInResponse = {
    id: existing?.id || crypto.randomUUID(),
    seasonKey: wc.seasonKey,
    seasonLabel: wc.seasonLabel,
    submittedVia: memberSession ? 'member' : 'guest',
    playerId: memberSession ? memberSession.userId : undefined,
    submittedAt: existing?.submittedAt || now,
    updatedAt: now,

    firstName,
    lastName,
    email,
    phone,

    participation: participation as WinterCheckInResponse['participation'],
    notPlayingReason: strOrUndef(body.notPlayingReason, 2000),

    emergencyContactName,
    emergencyContactNumber,

    usacId: strOrUndef(body.usacId, 60),
    cricclubsId: strOrUndef(body.cricclubsId, 60),
    role: strOrUndef(body.role, 40),
    battingPreference: strOrUndef(body.battingPreference, 60),
    bowlingStyle: strOrUndef(body.bowlingStyle, 60),

    experienceLevel: strOrUndef(body.experienceLevel, 60),
    playedBefore: strOrUndef(body.playedBefore, 300),
    howHeard: strOrUndef(body.howHeard, 60),
    membershipAcknowledged,

    unavailableMonths: strArray(body.unavailableMonths),
    weekendFrequency: weekendFrequency as WinterCheckInResponse['weekendFrequency'],
    availabilityCommitment: availabilityCommitment as
      | WinterCheckInResponse['availabilityCommitment']
      | undefined,
    awayFrom,
    awayTo,

    goals,
    leadershipInterest: oneOf(body.leadershipInterest, LEADERSHIP) as
      | WinterCheckInResponse['leadershipInterest']
      | undefined,
    goodSeasonLooksLike: strOrUndef(body.goodSeasonLooksLike, 2000),

    jerseyNeeds: strArray(body.jerseyNeeds, 60),
    jerseySize: oneOf(body.jerseySize, JERSEY_SIZE) as
      | WinterCheckInResponse['jerseySize']
      | undefined,
    jerseyName: strOrUndef(body.jerseyName, 20),
    jerseyNumber: strOrUndef(body.jerseyNumber, 3),

    nccaUmpireCertified: nccaRaw === 'yes',
    volunteerRoles: strArray(body.volunteerRoles, 60),

    liabilityAccepted,

    employmentStatus: oneOf(body.employmentStatus, EMPLOYMENT) as
      | WinterCheckInResponse['employmentStatus']
      | undefined,
    jobCompany: strOrUndef(body.jobCompany, 200),
    jobTitle: strOrUndef(body.jobTitle, 200),
    collegeName: strOrUndef(body.collegeName, 200),

    injuryNotes: strOrUndef(body.injuryNotes, 2000),
    anythingElse: strOrUndef(body.anythingElse, 2000),

    // Summer '26 feedback — members only; stripped entirely for guests.
    ...(memberSession
      ? {
          summerPlayed: summerPlayed as WinterCheckInResponse['summerPlayed'],
          summerFeltIncluded: summerFeltIncluded as
            | WinterCheckInResponse['summerFeltIncluded']
            | undefined,
          summerExperienceNotes,
          summerTeamsPlayedFor,
          summerNotifiedBeforeXI: summerNotifiedBeforeXI as
            | WinterCheckInResponse['summerNotifiedBeforeXI']
            | undefined,
          summerUmpired: summerUmpired as WinterCheckInResponse['summerUmpired'] | undefined,
          summerLeadershipFeedback:
            Object.keys(summerLeadershipFeedback).length > 0
              ? summerLeadershipFeedback
              : undefined,
          summerTeamImprovement,
          summerTeamSuggestions,
          summerPracticeNotes,
          summerJerseyNotes,
          summerOther,
        }
      : {}),
  };

  if (existingIndex >= 0) {
    all[existingIndex] = record;
  } else {
    all.push(record);
  }
  await store.setJSON(RESPONSES_KEY, all);

  // Back-fill the member's profile for fields we don't already have.
  if (memberSession && playerRecord) {
    const patch: Partial<Player> = {};
    if (!playerRecord.emergencyContactName && emergencyContactName) {
      patch.emergencyContactName = emergencyContactName;
    }
    if (!playerRecord.emergencyContactNumber && emergencyContactNumber) {
      patch.emergencyContactNumber = emergencyContactNumber;
    }
    if (!playerRecord.usacId && record.usacId) patch.usacId = record.usacId;
    if (!playerRecord.role && record.role) patch.role = record.role;
    if (!playerRecord.jobCompany && record.jobCompany) patch.jobCompany = record.jobCompany;
    if (!playerRecord.jobTitle && record.jobTitle) patch.jobTitle = record.jobTitle;

    if (Object.keys(patch).length > 0) {
      Object.assign(playerRecord, patch, { updatedAt: now, updatedBy: 'winter-checkin' });
      await playersStore.setJSON('players-all', players);
    }
  }

  const actor = memberSession ? email : `${email || 'guest'} (guest)`;
  await addAuditLog(
    actor,
    existing ? 'WINTER_CHECKIN_UPDATE' : 'WINTER_CHECKIN_SUBMIT',
    `${existing ? 'Updated' : 'Submitted'} winter check-in for ${wc.seasonLabel}: ${firstName} ${lastName} — ${participation}`,
    record.id,
    { entityType: 'winter-checkin', seasonKey: wc.seasonKey }
  );

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, updated: !!existing }),
  };
};
