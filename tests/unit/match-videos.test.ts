import { describe, it, expect } from 'vitest';
import { buildMatchVideos, youtubeVideoId } from '../../src/utils/matchVideos';
import type { Fixture } from '../../src/types/player';

const ID = 'dQw4w9WgXcQ';

describe('youtubeVideoId', () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=120s`,
    `https://m.youtube.com/watch?feature=share&v=${ID}`,
    `https://youtu.be/${ID}?si=abc`,
    `https://www.youtube.com/live/${ID}?si=abc`,
    `https://youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `youtube.com/watch?v=${ID}`,
    `  https://youtu.be/${ID}  `,
  ])('reads %s', (link) => {
    expect(youtubeVideoId(link)).toBe(ID);
  });

  it.each([
    undefined,
    '',
    'https://www.youtube.com/@GoldenStateCricketClub',
    'https://www.youtube.com/watch?v=short',
    `https://www.facebook.com/watch?v=${ID}`,
    'not a link',
  ])('rejects %s', (link) => {
    expect(youtubeVideoId(link)).toBeNull();
  });
});

function fixture(over: Partial<Fixture>): Fixture {
  return {
    id: over.id || 'f',
    seasonId: 's',
    gameNumber: 'Game 1',
    date: '2026-11-01',
    time: '9:00 AM',
    team: 'Tigers',
    opponent: 'Opponent',
    venue: '',
    division: 'Div 1',
    isHomeTeam: true,
    createdAt: '',
    createdBy: '',
    ...over,
  };
}

describe('buildMatchVideos', () => {
  it('orders by game date and time, not by when the link was added', () => {
    const videos = buildMatchVideos([
      {
        season: { name: 'Winter' },
        fixtures: [
          fixture({ id: 'new', date: '2026-11-08', youtubeVideoUrl: 'https://youtu.be/AAAAAAAAAAA' }),
          fixture({ id: 'none', date: '2026-11-09' }),
          fixture({ id: 'late', date: '2026-10-25', youtubeVideoUrl: 'https://youtu.be/BBBBBBBBBBB' }),
          fixture({ id: 'pm', date: '2026-11-08', time: '1:00 PM', youtubeVideoUrl: 'https://youtu.be/CCCCCCCCCCC' }),
        ],
      },
    ], '2026-11-14');
    expect(videos.map((v) => v.fixtureId)).toEqual(['pm', 'new', 'late']);
  });

  it('shows a video linked from two games once', () => {
    const videos = buildMatchVideos(
      [
        {
          season: { name: 'Winter' },
          fixtures: [
            fixture({ id: 'a', date: '2026-11-01', youtubeVideoUrl: `https://youtu.be/${ID}` }),
            fixture({ id: 'b', date: '2026-11-08', youtubeVideoUrl: `https://www.youtube.com/live/${ID}` }),
          ],
        },
      ],
      '2026-11-14',
    );
    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({ fixtureId: 'b', seasonName: 'Winter' });
  });

  it('leaves out games not played yet, even with a stream link already set', () => {
    const videos = buildMatchVideos([
      {
        season: { name: 'Winter' },
        fixtures: [
          fixture({ id: 'today', date: '2026-11-14', youtubeVideoUrl: 'https://youtu.be/AAAAAAAAAAA' }),
          fixture({ id: 'next', date: '2026-11-15', youtubeVideoUrl: 'https://youtu.be/BBBBBBBBBBB' }),
        ],
      },
    ], '2026-11-14');
    expect(videos.map((v) => v.fixtureId)).toEqual(['today']);
  });
});
