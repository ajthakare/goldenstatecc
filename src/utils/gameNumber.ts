/**
 * Game numbers are stored as the bare league number ("33"); the UI adds "Game #".
 * Strips a leading "Game" / "#" so typed or imported "Game 33" ends up the same.
 */
export function plainGameNumber(value: string): string {
  return value.trim().replace(/^game\s*/i, '').replace(/^#\s*/, '');
}
