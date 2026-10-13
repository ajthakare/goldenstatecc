/**
 * Unit Tests: what other members can see on a profile (netlify/functions/_profile-stats.ts)
 * Profiles and /players are members-only; the public only sees the Club Feed.
 */

import { describe, it, expect } from 'vitest';
import { isListedMember, toDirectoryCard, toPublicProfile } from '../../netlify/functions/_profile-stats';
import { buildFeed } from '../../src/utils/feed';
import type { FeedPlayer } from '../../src/utils/feed';
import type { Player } from '../../src/types/player';

const member = (extra: Partial<Player> = {}): Player => ({
  id: 'p1', firstName: 'Riya', lastName: 'Rao', isActive: true, passwordHash: 'hash',
  registrationStatus: 'approved', email: 'r@example.com', phone: '+1 5551234567',
  usacId: 'USAC1', emergencyContactName: 'Mum', emergencyContactNumber: '+1 5550000000',
  jobCompany: 'Acme', jobTitle: 'Engineer', photoUpdatedAt: '2026-10-01T00:00:00Z',
  createdAt: '', updatedAt: '', createdBy: '', updatedBy: '', ...extra,
} as Player);

describe('profile visibility', () => {
  it('never exposes email, USAC ID, emergency contact or password', () => {
    const p = member({ privacy: { showPhone: true } });
    const json = JSON.stringify([toPublicProfile(p, null), toDirectoryCard(p, null)]);
    for (const secret of ['r@example.com', 'USAC1', 'Mum', '5550000000', 'hash']) {
      expect(json).not.toContain(secret);
    }
  });

  it('applies the member\'s phone/company settings, phone hidden by default', () => {
    expect(toPublicProfile(member(), null)).toMatchObject({ phone: undefined, jobCompany: 'Acme', jobTitle: 'Engineer' });
    const p = member({ privacy: { showPhone: true, showCompany: false } });
    expect(toPublicProfile(p, null)).toMatchObject({ phone: '+1 5551234567', jobCompany: undefined, jobTitle: undefined });
  });

  it('never lists inactive, unapproved or admin accounts', () => {
    expect(isListedMember(member())).toBe(true);
    expect(isListedMember(member({ isActive: false }))).toBe(false);
    expect(isListedMember(member({ registrationStatus: 'pending' }))).toBe(false);
    expect(isListedMember(member({ passwordHash: undefined }))).toBe(false);
    expect(isListedMember(member({ firstName: 'admin', lastName: 'User' }))).toBe(false);
  });

  it('shows names without profile links or photos in the public feed', () => {
    // club-feed-get passes listed: false and no photo for signed-out visitors
    const players = new Map<string, FeedPlayer>([['p1', { id: 'p1', name: 'Riya Rao', listed: false }]]);
    const { items } = buildFeed({
      fixtures: [{
        id: 'f1', seasonId: 's', gameNumber: '1', date: '2026-06-01', time: '', team: 'Tigers', opponent: 'X',
        venue: '', division: '', isHomeTeam: true, result: 'win', playerOfMatch: 'p1', createdAt: '', createdBy: '',
      }],
      players,
      events: [],
      social: [],
      todayStr: '2026-06-10',
    });
    expect(items[0].potm).toEqual({ playerName: 'Riya Rao', playerId: undefined, photoUrl: undefined, note: undefined });
  });
});
