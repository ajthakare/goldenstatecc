/**
 * Unit Tests: admin role checks use the player database, not just the token
 * (netlify/functions/_admin-auth.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let players: any[] = [];
let lookups = 0;

vi.mock('@netlify/blobs', () => ({
  getStore: () => ({
    get: async () => {
      lookups++;
      return players;
    },
  }),
}));

const { currentRole, isCurrentAdmin, isCurrentSuperAdmin, _resetAdminAuthCache } = await import(
  '../../netlify/functions/_admin-auth'
);

const session = (role: 'member' | 'admin' | 'super_admin', userId = 'u1') => ({ userId, email: 'x@y.z', role });
const player = (extra: Record<string, unknown> = {}) => ({
  id: 'u1', firstName: 'A', lastName: 'B', isActive: true, registrationStatus: 'approved', role_auth: 'admin', ...extra,
});

describe('current admin role', () => {
  beforeEach(() => {
    _resetAdminAuthCache();
    lookups = 0;
  });

  it('rejects member tokens without a database lookup', async () => {
    players = [player({ role_auth: 'super_admin' })];
    expect(await isCurrentAdmin(session('member'))).toBe(false);
    expect(lookups).toBe(0);
  });

  it('accepts an admin who is still an admin', async () => {
    players = [player()];
    expect(await isCurrentAdmin(session('admin'))).toBe(true);
    expect(await isCurrentSuperAdmin(session('admin'))).toBe(false);
  });

  it('rejects an admin who has since been demoted', async () => {
    players = [player({ role_auth: 'member' })];
    expect(await isCurrentAdmin(session('admin'))).toBe(false);
    expect(await currentRole(session('super_admin'))).toBe('member');
  });

  it('downgrades a super admin demoted to admin', async () => {
    players = [player({ role_auth: 'admin' })];
    expect(await currentRole(session('super_admin'))).toBe('admin');
    expect(await isCurrentSuperAdmin(session('super_admin'))).toBe(false);
    expect(await isCurrentAdmin(session('super_admin'))).toBe(true);
  });

  it('does not upgrade an admin token on promotion until the next login', async () => {
    players = [player({ role_auth: 'super_admin' })];
    expect(await currentRole(session('admin'))).toBe('admin');
  });

  it('rejects suspended, deactivated and deleted accounts', async () => {
    players = [player({ registrationStatus: 'suspended' })];
    expect(await isCurrentAdmin(session('admin'))).toBe(false);
    _resetAdminAuthCache();
    players = [player({ isActive: false })];
    expect(await isCurrentAdmin(session('admin'))).toBe(false);
    _resetAdminAuthCache();
    players = [];
    expect(await isCurrentAdmin(session('admin'))).toBe(false);
  });
});
