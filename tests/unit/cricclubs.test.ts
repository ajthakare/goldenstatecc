import { describe, it, expect } from 'vitest';
import { checkCricclubsId, checkCricclubsUrl, findCricclubsIdOwner } from '../../src/utils/cricclubs';

describe('checkCricclubsId', () => {
  it('accepts the CC Player ID number, trimmed', () => {
    expect(checkCricclubsId(' 123456 ')).toEqual({ ok: true, value: '123456' });
  });

  it('treats empty as clearing the field', () => {
    for (const input of ['', '   ', null, undefined]) {
      expect(checkCricclubsId(input)).toEqual({ ok: true, value: undefined });
    }
  });

  it('rejects anything that is not just digits', () => {
    for (const input of ['USACP02210009056', '154 8641', 'XXXXXXXX', '12345678901', '-5']) {
      expect(checkCricclubsId(input).ok).toBe(false);
    }
  });
});

describe('checkCricclubsUrl', () => {
  it('accepts a cricclubs.com profile link', () => {
    const url = 'https://cricclubs.com/NCCA/user/XXXXXXXX?playerName=Your+Name';
    expect(checkCricclubsUrl(url)).toEqual({ ok: true, value: url });
  });

  it('accepts cricclubs.com subdomains', () => {
    expect(checkCricclubsUrl('https://www.cricclubs.com/NCCA/user/abc').ok).toBe(true);
  });

  it('treats empty as clearing the field', () => {
    expect(checkCricclubsUrl('  ')).toEqual({ ok: true, value: undefined });
  });

  it('rejects other sites, http and non-URLs', () => {
    for (const input of [
      'https://evilcricclubs.com/NCCA/user/abc',
      'http://cricclubs.com/NCCA/user/abc',
      'cricclubs.com/NCCA/user/abc',
      'javascript:alert(1)',
      `https://cricclubs.com/${'a'.repeat(500)}`,
    ]) {
      expect(checkCricclubsUrl(input).ok).toBe(false);
    }
  });
});

describe('findCricclubsIdOwner', () => {
  const players = [
    { id: 'a', cricclubsId: '123456' },
    { id: 'b', cricclubsId: '654321' },
    { id: 'c' },
  ];

  it('finds another player with the same ID', () => {
    expect(findCricclubsIdOwner(players, '123456', 'c')?.id).toBe('a');
  });

  it("ignores the player's own record", () => {
    expect(findCricclubsIdOwner(players, '123456', 'a')).toBeUndefined();
  });

  it('returns undefined when nobody has it', () => {
    expect(findCricclubsIdOwner(players, '999', 'c')).toBeUndefined();
  });
});
