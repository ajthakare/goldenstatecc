import type { Handler, HandlerEvent } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { logoutCookies, sessionFromHeaders, verifyPassword } from '../../src/middleware/auth';
import type { Player } from '../../src/types/player';
import { addAuditLog } from '../../src/utils/auditLog';
import { readPlayersForUpdate, writePlayers } from './_players-store';
import { blobStore } from './_profile-stats';
import { removePlayerDevices } from './_push-utils';
import { updateJSON } from './_blobs';

/**
 * A player deletes their own account (required by the App Store and Google Play).
 * POST /.netlify/functions/account-delete  Body: { password }
 * Works from the app (Bearer token) and the website (/account/delete, cookie).
 *
 * Deleted: the login (email, password, registration and role), phone, USAC ID,
 * emergency contact, job, privacy settings, profile photo, push devices
 * (browsers and the app), pending password-reset requests and the legacy
 * admin-users entry. Kept as club records: the player's name, cricket profile
 * (role, batting/bowling style, CricClubs link) and everything in fixtures,
 * availability, Player of the Match and statistics.
 * The email is freed, so the person can register again later.
 */
export const DELETED_FIELDS = [
  'email',
  'passwordHash',
  'phone',
  'usacId',
  'emergencyContactName',
  'emergencyContactNumber',
  'jobCompany',
  'jobTitle',
  'photoUpdatedAt',
  'privacy',
  'registrationStatus',
  'role_auth',
  'registeredAt',
  'approvedAt',
  'approvedBy',
  'lastLogin',
] as const satisfies ReadonlyArray<keyof Player>;

const json = (statusCode: number, body: unknown, extra: Record<string, unknown> = {}) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
  ...extra,
});

export const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const session = sessionFromHeaders(event.headers);
  if (!session) {
    return json(401, { error: 'Please sign in again to delete your account' });
  }

  let password: unknown;
  try {
    ({ password } = JSON.parse(event.body || '{}'));
  } catch {
    return json(400, { error: 'Invalid request' });
  }
  if (typeof password !== 'string' || !password) {
    return json(400, { error: 'Enter your password to confirm' });
  }

  try {
    const players = await readPlayersForUpdate();
    const player = players.find((p) => p.id === session.userId);
    if (!player || !player.passwordHash) {
      return json(404, { error: 'Account not found' });
    }
    if (!(await verifyPassword(password, player.passwordHash))) {
      return json(401, { error: 'Incorrect password' });
    }

    // Never leave the club without a super admin
    if (player.role_auth === 'super_admin') {
      const others = players.filter(
        (p) => p.id !== player.id && p.role_auth === 'super_admin' && p.passwordHash &&
          (!p.registrationStatus || p.registrationStatus === 'approved')
      );
      if (others.length === 0) {
        return json(409, { error: 'You are the only super admin. Make someone else super admin first.' });
      }
    }

    const email = player.email?.toLowerCase();
    const name = `${player.firstName} ${player.lastName}`.trim();
    const wasRole = player.role_auth || 'member';
    for (const field of DELETED_FIELDS) delete player[field];
    const now = new Date().toISOString();
    player.accountDeletedAt = now;
    player.updatedAt = now;
    player.updatedBy = 'account-delete';
    await writePlayers(players);

    // The rest is clean-up: the account is already gone, so a failure here is logged, not returned
    const cleanups: Array<[string, () => Promise<unknown>]> = [
      ['photo', async () => {
        const avatars = blobStore('player-avatars');
        await avatars.delete(`avatar-${player.id}`);
        await avatars.delete(`avatar-small-${player.id}`);
      }],
      ['push devices', () => removePlayerDevices(player.id)],
      ['password reset requests', () =>
        updateJSON<any[]>(blobStore('password-reset-requests'), 'requests', (current) =>
          current && current.some((r) => r.userId === player.id) ? current.filter((r) => r.userId !== player.id) : null
        )],
      ['admin-users entry', async () => {
        if (!email) return;
        const store = getStore({
          name: 'admin-users',
          siteID: process.env.SITE_ID || '',
          token: process.env.NETLIFY_AUTH_TOKEN || '',
        });
        await updateJSON<Array<{ username: string }>>(store, 'users', (current) =>
          current && current.some((u) => u.username?.toLowerCase() === email)
            ? current.filter((u) => u.username?.toLowerCase() !== email)
            : null
        );
      }],
    ];
    for (const [what, run] of cleanups) {
      try {
        await run();
      } catch (error) {
        console.error(`account-delete: could not remove ${what} for ${player.id}:`, error);
      }
    }

    // Audit trail without the deleted email
    await addAuditLog(
      `${name} (self)`,
      'ACCOUNT_DELETED',
      `${name} deleted their account`,
      player.id,
      { role: wasRole, via: event.headers.authorization ? 'app' : 'website' }
    );

    // Website: also sign the browser out
    return json(200, { success: true }, {
      multiValueHeaders: { 'Set-Cookie': logoutCookies(process.env.NODE_ENV === 'production', event.headers.host) },
    });
  } catch (error) {
    console.error('account-delete error:', error);
    return json(500, { error: 'Could not delete your account. Please try again.' });
  }
};
