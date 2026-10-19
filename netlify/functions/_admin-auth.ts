/**
 * Role checks against the player database, not just the session token.
 *
 * Session tokens last 15 days and carry the role from login time, so on their
 * own they'd let a demoted, suspended or deleted admin keep admin access until
 * the token expires. These helpers use the token only to rule people OUT (a
 * member token is rejected without any lookup), then confirm the CURRENT role
 * and account status (deleted, or registrationStatus suspended/rejected/pending)
 * in `players-all`. A token can lose privileges this way,
 * never gain them: someone newly promoted gets admin access at their next login.
 */
import { getStore } from '@netlify/blobs';
import type { AuthRole, SessionPayload } from '../../src/middleware/auth';
import type { Player } from '../../src/types/player';

// One function invocation often checks the role more than once; admin traffic is
// low, so a few seconds of reuse is plenty (a role change applies within 5s).
const CACHE_MS = 5000;
let cache: { at: number; players: Player[] } | null = null;

async function loadPlayers(): Promise<Player[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.players;
  const store = getStore({
    name: 'players',
    siteID: process.env.SITE_ID || '',
    token: process.env.NETLIFY_AUTH_TOKEN || '',
  });
  const players = ((await store.get('players-all', { type: 'json' })) as Player[] | null) || [];
  cache = { at: Date.now(), players };
  return players;
}

/** The session holder's role right now, or null if they no longer have an active account. */
export async function currentRole(session: SessionPayload | null): Promise<AuthRole | null> {
  if (!session?.userId) return null;
  // Never look up members: the token can only narrow access, not widen it
  if (session.role !== 'admin' && session.role !== 'super_admin') return session.role ?? null;

  // Account status only: `isActive` is the club roster flag (playing this
  // season), not an account switch, so an admin who isn't playing keeps access
  const player = (await loadPlayers()).find((p) => p.id === session.userId);
  if (!player) return null;
  if (player.registrationStatus && player.registrationStatus !== 'approved') return null;

  const role = (player.role_auth || 'member') as AuthRole;
  // Effective role is the lower of token and database (a promotion needs a new login)
  if (role === 'super_admin') return session.role;
  if (role === 'admin') return 'admin';
  return 'member';
}

export async function isCurrentAdmin(session: SessionPayload | null): Promise<boolean> {
  const role = await currentRole(session);
  return role === 'admin' || role === 'super_admin';
}

export async function isCurrentSuperAdmin(session: SessionPayload | null): Promise<boolean> {
  return (await currentRole(session)) === 'super_admin';
}

/** Tests only: forget cached player data. */
export function _resetAdminAuthCache(): void {
  cache = null;
}
