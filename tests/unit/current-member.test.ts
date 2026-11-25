/**
 * Unit Tests: member endpoints re-check the account, not just the token.
 *
 * Session tokens stay valid for 15 days (website) or 30 (app) after they're
 * issued. isCurrentMember() looks the player up in players-all with the same
 * rule as login, so a deleted, suspended or removed player is refused at once.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Player } from '../../src/types/player';

let players: Partial<Player>[] = [];
vi.mock('@netlify/blobs', () => ({
  getStore: () => ({
    get: async (key: string) => (key === 'players-all' ? structuredClone(players) : null),
    getWithMetadata: async () => null,
  }),
}));

import { isCurrentMember, _resetAdminAuthCache } from '../../netlify/functions/_admin-auth';
import { createSession, validateSession } from '../../src/middleware/auth';

const FUNCTIONS_DIR = join(__dirname, '../../netlify/functions');
const session = (userId: string, role: 'member' | 'admin' | 'super_admin' = 'member') =>
  validateSession(createSession(userId, `${userId}@example.com`, role))!;

const active = { id: 'ok', email: 'ok@example.com', passwordHash: 'h', registrationStatus: 'approved' as const };

beforeEach(() => {
  _resetAdminAuthCache();
  players = [
    active,
    { id: 'legacy', email: 'l@example.com', passwordHash: 'h' }, // from before registrations
    { id: 'deleted', firstName: 'Gone', accountDeletedAt: '2026-11-25' },
    { id: 'suspended', email: 's@example.com', passwordHash: 'h', registrationStatus: 'suspended' },
    { id: 'pending', email: 'p@example.com', passwordHash: 'h', registrationStatus: 'pending' },
  ];
});

describe('isCurrentMember', () => {
  it('accepts active accounts of any role', async () => {
    expect(await isCurrentMember(session('ok'))).toBe(true);
    expect(await isCurrentMember(session('ok', 'admin'))).toBe(true);
    expect(await isCurrentMember(session('legacy'))).toBe(true);
  });

  it('refuses deleted, suspended, pending and unknown accounts despite a valid token', async () => {
    for (const id of ['deleted', 'suspended', 'pending', 'nobody']) {
      expect(await isCurrentMember(session(id)), id).toBe(false);
    }
    expect(await isCurrentMember(null)).toBe(false);
  });
});

// ---- Every member endpoint uses it ----

const sources = readdirSync(FUNCTIONS_DIR)
  .filter((f) => f.endsWith('.ts') && !f.startsWith('_'))
  .map((f) => ({ name: f.replace(/\.ts$/, ''), src: readFileSync(join(FUNCTIONS_DIR, f), 'utf8') }));

describe('member endpoints', () => {
  for (const { name, src } of sources) {
    it(`${name} checks the account, not just the token's role`, () => {
      expect(src).not.toMatch(/\bisMember\s*\(/);
    });
  }

  // Classic handlers that refuse non-members outright (others only show extra details to members)
  const gated = sources
    .filter(({ src }) => src.includes('!(await isCurrentMember(session))') && /export const handler/.test(src))
    .map(({ name }) => name);

  it('finds the members-only endpoints', () => {
    expect(gated.length).toBeGreaterThan(10);
    expect(gated).toEqual(expect.arrayContaining(['member-availability-update', 'profile-update', 'players-directory']));
  });

  for (const name of gated) {
    it(`${name} refuses a deleted player's still-valid token`, async () => {
      const mod = await import(join(FUNCTIONS_DIR, `${name}.ts`));
      const codes: number[] = [];
      for (const httpMethod of ['GET', 'POST', 'PUT', 'DELETE']) {
        const res = await mod.handler(
          {
            httpMethod,
            headers: { authorization: `Bearer ${createSession('deleted', 'gone@example.com', 'member')}` },
            queryStringParameters: { id: 'ok', playerId: 'ok', fixtureId: 'f1', practiceId: 'x' },
            body: '{}',
            isBase64Encoded: false,
          },
          {}
        );
        codes.push(res.statusCode);
      }
      expect(codes.every((c) => [401, 403, 405].includes(c)), `${name}: ${codes}`).toBe(true);
      expect(codes.some((c) => c === 401 || c === 403), `${name}: ${codes}`).toBe(true);
    });
  }
});
