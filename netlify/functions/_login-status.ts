/**
 * Who may hold a session, shared by auth-login (website and app) and
 * auth-refresh (app), so signing in and staying signed in follow one rule.
 */
import type { AuthRole } from '../../src/middleware/auth';
import type { Player } from '../../src/types/player';

export interface LoginBlock {
  statusCode: 401 | 403;
  error: string;
}

/**
 * Why this player can't have a session, or null if they can.
 * No login (no email or password) reads as bad credentials so it reveals nothing;
 * pending, rejected and suspended registrations get their own messages.
 * A missing registrationStatus is an account created before registrations existed: allowed.
 */
export function loginBlock(player: Player | undefined): LoginBlock | null {
  if (!player || !player.email || !player.passwordHash) {
    return { statusCode: 401, error: 'Invalid credentials' };
  }
  switch (player.registrationStatus) {
    case 'pending':
      return { statusCode: 403, error: 'Registration pending approval by admin' };
    case 'rejected':
      return { statusCode: 403, error: 'Registration not approved' };
    case 'suspended':
      return { statusCode: 403, error: 'Account suspended. Contact admin.' };
    default:
      return null;
  }
}

/** The role and display name a new session for this player carries. */
export function sessionClaims(player: Player): { role: AuthRole; displayName?: string } {
  const role: AuthRole = player.role_auth || 'member';
  // Admins show their name in the admin pages; members don't need one in the token
  const displayName =
    role === 'super_admin' || role === 'admin'
      ? `${player.firstName} ${player.lastName}`.trim() || player.email
      : undefined;
  return { role, displayName };
}

/** The user summary returned to the website and the app after login or refresh. */
export function sessionUser(player: Player, role: AuthRole) {
  return {
    id: player.id,
    email: player.email,
    firstName: player.firstName,
    lastName: player.lastName,
    role,
  };
}
