/**
 * CricClubs player ID and profile link: checks shared by the member profile,
 * the admin player editor and the player CSV import.
 *
 * The ID is the number shown as "CC Player ID" on a CricClubs profile
 * (e.g. 123456). The link uses a different, scrambled code
 * (cricclubs.com/NCCA/user/XXXXXXXX), so one can't be worked
 * out from the other and both are stored.
 */

/** ok with the cleaned value (undefined = clear the field), or not ok with a message for the user. */
export type CheckResult = { ok: boolean; value?: string; error?: string };

/** Empty clears the field. Otherwise digits only, up to 10. */
export function checkCricclubsId(input: unknown): CheckResult {
  const value = String(input ?? '').trim();
  if (!value) return { ok: true, value: undefined };
  if (!/^\d{1,10}$/.test(value)) {
    return { ok: false, error: 'CricClubs ID must be the number shown as "CC Player ID" on your CricClubs profile' };
  }
  return { ok: true, value };
}

/** Empty clears the field. Otherwise a full https link on cricclubs.com, up to 500 characters. */
export function checkCricclubsUrl(input: unknown): CheckResult {
  const value = String(input ?? '').trim();
  if (!value) return { ok: true, value: undefined };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'CricClubs link must be a full URL (https://cricclubs.com/...)' };
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || !(host === 'cricclubs.com' || host.endsWith('.cricclubs.com')) || value.length > 500) {
    return { ok: false, error: 'Please enter a link to your profile on cricclubs.com' };
  }
  return { ok: true, value: parsed.toString() };
}

/** The other player already using this CricClubs ID, if any. */
export function findCricclubsIdOwner<T extends { id: string; cricclubsId?: string }>(
  players: T[],
  cricclubsId: string,
  exceptPlayerId: string
): T | undefined {
  return players.find((p) => p.id !== exceptPlayerId && p.cricclubsId === cricclubsId);
}
