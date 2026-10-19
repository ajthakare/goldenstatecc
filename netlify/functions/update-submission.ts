import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { getStore } from '@netlify/blobs';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';

interface SubmissionMetadata {
  id: string;
  read: boolean;
  archived: boolean;
  updatedAt: string;
  updatedBy: string;
}

/**
 * Update submission status or delete submission
 * POST /api/update-submission
 * Body: { id, action: 'mark-read' | 'mark-unread' | 'archive' | 'unarchive' | 'delete' }
 * Requires: Valid admin session
 * Returns: Success message
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    // Validate admin session
    const cookieHeader = event.headers.cookie;
    const session = validateAdminSession(cookieHeader);

    if (!session) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    // Admin endpoint: a valid member session isn't enough
    if (!(await isCurrentAdmin(session))) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'Admin access required' }),
      };
    }

    // Parse request body
    const body = JSON.parse(event.body || '{}');
    const { id, action } = body;

    if (!id || !action) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Submission ID and action are required' }),
      };
    }

    const validActions = [
      'mark-read',
      'mark-unread',
      'archive',
      'unarchive',
      'delete',
    ];
    if (!validActions.includes(action)) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: `Invalid action. Must be one of: ${validActions.join(', ')}`,
        }),
      };
    }

    // Handle delete action (requires calling Netlify API)
    if (action === 'delete') {
      const netlifyToken = process.env.NETLIFY_AUTH_TOKEN;
      if (!netlifyToken) {
        return {
          statusCode: 500,
          body: JSON.stringify({
            error: 'NETLIFY_AUTH_TOKEN not configured',
          }),
        };
      }

      const deleteUrl = `https://api.netlify.com/api/v1/submissions/${id}`;
      const deleteResponse = await fetch(deleteUrl, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${netlifyToken}`,
        },
      });

      if (!deleteResponse.ok) {
        const errorText = await deleteResponse.text();
        console.error('Failed to delete submission:', errorText);
        return {
          statusCode: deleteResponse.status,
          body: JSON.stringify({
            error: 'Failed to delete submission',
            details: errorText,
          }),
        };
      }

      // Also remove metadata from Blobs
      const store = getStore({
        name: 'submission-metadata',
        siteID: process.env.SITE_ID || '',
        token: process.env.NETLIFY_AUTH_TOKEN || '',
      });
      const allMetadata =
        (await store.get('metadata', { type: 'json' })) as
          | SubmissionMetadata[]
          | null;

      if (allMetadata) {
        const filtered = allMetadata.filter((m) => m.id !== id);
        await store.set('metadata', JSON.stringify(filtered));
      }

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          success: true,
          message: 'Submission deleted successfully',
          id,
        }),
      };
    }

    // Handle read/archive actions (store metadata in Netlify Blobs)
    const store = getStore({
      name: 'submission-metadata',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });
    const allMetadata =
      (await store.get('metadata', { type: 'json' })) as
        | SubmissionMetadata[]
        | null;

    const existingMetadata = allMetadata || [];
    const metadataIndex = existingMetadata.findIndex((m) => m.id === id);

    let metadata: SubmissionMetadata;

    if (metadataIndex >= 0) {
      // Update existing metadata
      metadata = existingMetadata[metadataIndex];
    } else {
      // Create new metadata entry
      metadata = {
        id,
        read: false,
        archived: false,
        updatedAt: new Date().toISOString(),
        updatedBy: session.username,
      };
    }

    // Apply action
    switch (action) {
      case 'mark-read':
        metadata.read = true;
        break;
      case 'mark-unread':
        metadata.read = false;
        break;
      case 'archive':
        metadata.archived = true;
        break;
      case 'unarchive':
        metadata.archived = false;
        break;
    }

    metadata.updatedAt = new Date().toISOString();
    metadata.updatedBy = session.username;

    // Update metadata array
    if (metadataIndex >= 0) {
      existingMetadata[metadataIndex] = metadata;
    } else {
      existingMetadata.push(metadata);
    }

    // Save to Netlify Blobs
    await store.set('metadata', JSON.stringify(existingMetadata));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        success: true,
        message: 'Submission updated successfully',
        id,
        action,
        metadata,
      }),
    };
  } catch (error) {
    console.error('Error updating submission:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to update submission',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
