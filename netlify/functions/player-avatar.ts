import { Handler, HandlerEvent } from '@netlify/functions';
import { validateAdminSession, isMember } from '../../src/middleware/auth';
import { blobStore } from './_profile-stats';

/**
 * Serve a player's profile photo
 * GET /.netlify/functions/player-avatar?id=<playerId>&v=<photoUpdatedAt>[&size=small]
 * size=small serves the 240px copy (falls back to the 400px photo for photos
 * uploaded before small copies existed).
 * Requires: any signed-in member (photos are members-only, like profiles)
 * `v` changes on every upload, so the browser can cache each version for a long time.
 */
export const handler: Handler = async (event: HandlerEvent) => {
  try {
    const session = validateAdminSession(event.headers.cookie);
    if (!session || !isMember(session)) {
      return { statusCode: 401, body: 'Authentication required' };
    }

    const id = event.queryStringParameters?.id;
    if (!id) return { statusCode: 400, body: 'Player ID is required' };

    const store = blobStore('player-avatars');
    const result =
      (event.queryStringParameters?.size === 'small'
        ? await store.getWithMetadata(`avatar-small-${id}`, { type: 'arrayBuffer' })
        : null) || (await store.getWithMetadata(`avatar-${id}`, { type: 'arrayBuffer' }));
    if (!result) return { statusCode: 404, body: 'No photo' };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': (result.metadata?.contentType as string) || 'image/webp',
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
      body: Buffer.from(result.data).toString('base64'),
      isBase64Encoded: true,
    };
  } catch (error) {
    console.error('Avatar fetch error:', error);
    return { statusCode: 500, body: 'Failed to load photo' };
  }
};
