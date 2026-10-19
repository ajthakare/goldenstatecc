import { Handler, HandlerEvent } from '@netlify/functions';
import { validateAdminSession, isMember } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';
import { addAuditLog } from '../../src/utils/auditLog';
import { blobStore, loadPlayers } from './_profile-stats';
import { readPlayersForUpdate, writePlayers } from './_players-store';

/**
 * Upload or remove a profile photo
 *
 * POST /.netlify/functions/profile-photo[?variant=small]
 *   Body: raw image bytes (Content-Type image/webp, image/jpeg or image/png).
 *   The browser crops + resizes before upload: 400x400 (the photo; also bumps
 *   photoUpdatedAt so every page picks up the new version) and, sent first,
 *   a 240x240 `variant=small` copy for small avatars.
 *   Always updates the caller's own photo.
 *
 * DELETE /.netlify/functions/profile-photo[?playerId=<id>]
 *   Removes the caller's photo, or (admins only) another player's photo.
 */

const MAX_BYTES = 512 * 1024;

function detectImageType(bytes: Buffer): string | null {
  if (bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 8 && bytes.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'image/png';
  return null;
}

export const handler: Handler = async (event: HandlerEvent) => {
  try {
    const session = validateAdminSession(event.headers.cookie);
    if (!session || !isMember(session)) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Authentication required' }) };
    }

    if (event.httpMethod !== 'POST' && event.httpMethod !== 'DELETE') {
      return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const targetId =
      event.httpMethod === 'DELETE' && event.queryStringParameters?.playerId
        ? event.queryStringParameters.playerId
        : session.userId;
    if (targetId !== session.userId && !(await isCurrentAdmin(session))) {
      return { statusCode: 403, body: JSON.stringify({ error: 'You can only change your own photo' }) };
    }

    const playersStore = blobStore('players');
    const avatarsStore = blobStore('player-avatars');
    const players = await readPlayersForUpdate();
    const player = players.find((p) => p.id === targetId);
    if (!player) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Player not found' }) };
    }
    const playerName = `${player.firstName} ${player.lastName}`;
    const actor = session.email || session.username || session.userId;

    if (event.httpMethod === 'DELETE') {
      await avatarsStore.delete(`avatar-${targetId}`);
      await avatarsStore.delete(`avatar-small-${targetId}`);
      player.photoUpdatedAt = undefined;
      player.updatedAt = new Date().toISOString();
      player.updatedBy = actor;
      await writePlayers(players);
      await addAuditLog(actor, 'PROFILE_PHOTO_REMOVED', `Removed profile photo for ${playerName}`, targetId, {
        entityType: 'player',
      }).catch((err) => console.error('Audit log failed:', err));
      return { statusCode: 200, body: JSON.stringify({ success: true }) };
    }

    // POST: upload
    const bytes = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'binary');
    if (bytes.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No image received' }) };
    }
    if (bytes.length > MAX_BYTES) {
      return { statusCode: 413, body: JSON.stringify({ error: 'Image is too large (max 512 KB)' }) };
    }
    const contentType = detectImageType(bytes);
    if (!contentType) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Please upload a JPEG, PNG or WebP image' }) };
    }

    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    // Small copy: stored alongside, served once the full upload bumps the version
    if (event.queryStringParameters?.variant === 'small') {
      await avatarsStore.set(`avatar-small-${targetId}`, arrayBuffer, {
        metadata: { contentType, uploadedAt: new Date().toISOString() },
      });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true }),
      };
    }

    await avatarsStore.set(`avatar-${targetId}`, arrayBuffer, { metadata: { contentType } });

    // The small copy is uploaded just before this. If it's missing or left over
    // from an older photo, drop it so the new full photo is served instead.
    const small = await avatarsStore.getMetadata(`avatar-small-${targetId}`);
    const smallAt = Date.parse(String(small?.metadata?.uploadedAt || ''));
    if (small && !(Date.now() - smallAt < 10 * 60 * 1000)) {
      await avatarsStore.delete(`avatar-small-${targetId}`);
    }

    const now = new Date().toISOString();
    player.photoUpdatedAt = now;
    player.updatedAt = now;
    player.updatedBy = actor;
    await writePlayers(players);

    await addAuditLog(actor, 'PROFILE_PHOTO_UPDATED', `Updated profile photo for ${playerName}`, targetId, {
      entityType: 'player',
    }).catch((err) => console.error('Audit log failed:', err));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, photoUpdatedAt: now }),
    };
  } catch (error) {
    console.error('Profile photo error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to update profile photo' }) };
  }
};
