import type { Fixture, Season } from '../types/player';

/**
 * Match videos for /gallery, built from the stream links admins add to fixtures
 * (`fixture.youtubeVideoUrl`). A YouTube link alone is enough: the thumbnail only
 * needs the video id, so no YouTube API key is involved. Cards open the link on YouTube.
 *
 * Videos are ordered by when the game was played, not when the link was added,
 * so a link added two weeks after a game lands in that game's place.
 */

export interface MatchVideo {
  videoId: string;
  fixtureId: string;
  /** YYYY-MM-DD */
  date: string;
  time: string;
  team: string;
  opponent: string;
  division: string;
  seasonName: string;
  /** The link as the admin entered it, for "Watch on YouTube" */
  url: string;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The 11-character video id from any common YouTube link: watch?v=, youtu.be/,
 * /live/, /shorts/, /embed/, /v/, m. and music. hosts. Null for anything else
 * (a channel page, a Facebook stream, a typo).
 */
export function youtubeVideoId(link: string | undefined | null): string | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link.trim().replace(/^(?!https?:\/\/)/i, 'https://'));
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1] || null;
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v');
    if (!id) {
      const [, kind, rest] = url.pathname.split('/');
      if (['live', 'shorts', 'embed', 'v'].includes(kind)) id = rest || null;
    }
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

export function youtubeThumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

// "9:00 AM" -> "09:00", for sorting two games on the same day
function sortableTime(time: string): string {
  const m = (time || '').match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return '00:00';
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === 'PM') h += 12;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/**
 * Every fixture with a YouTube link played on or before `today` (YYYY-MM-DD),
 * newest game first. Upcoming games can already carry their stream link; they
 * wait until match day. The same video linked from two fixtures shows once (on
 * the later game).
 */
export function buildMatchVideos(
  seasons: { season: Pick<Season, 'name'>; fixtures: Fixture[] }[],
  today: string,
): MatchVideo[] {
  const videos: (MatchVideo & { sortKey: string })[] = [];
  for (const { season, fixtures } of seasons) {
    for (const f of fixtures) {
      const videoId = youtubeVideoId(f.youtubeVideoUrl);
      if (!videoId || !f.date) continue;
      const date = f.date.slice(0, 10);
      if (date > today) continue;
      videos.push({
        videoId,
        fixtureId: f.id,
        date,
        time: f.time || '',
        team: f.team,
        opponent: f.opponent,
        division: f.division,
        seasonName: season.name,
        url: f.youtubeVideoUrl!.trim(),
        sortKey: `${date}T${sortableTime(f.time)}`,
      });
    }
  }
  videos.sort((a, b) => b.sortKey.localeCompare(a.sortKey) || a.team.localeCompare(b.team));
  const seen = new Set<string>();
  return videos
    .filter((v) => (seen.has(v.videoId) ? false : (seen.add(v.videoId), true)))
    .map(({ sortKey: _sortKey, ...v }) => v);
}
