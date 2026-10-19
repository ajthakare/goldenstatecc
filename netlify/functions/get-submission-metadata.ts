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
 * Get submission metadata (read/archived status)
 * GET /api/get-submission-metadata
 * Requires: Valid admin session
 * Returns: Object mapping submission IDs to metadata
 */
export const handler: Handler = async (
  event: HandlerEvent,
  context: HandlerContext
) => {
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

    // Get metadata from Netlify Blobs
    const store = getStore({
      name: 'submission-metadata',
      siteID: process.env.SITE_ID || '',
      token: process.env.NETLIFY_AUTH_TOKEN || '',
    });

    const allMetadata =
      (await store.get('metadata', { type: 'json' })) as
        | SubmissionMetadata[]
        | null;

    // Convert array to object mapping ID to metadata
    const metadataMap: Record<string, SubmissionMetadata> = {};

    if (allMetadata && Array.isArray(allMetadata)) {
      allMetadata.forEach((item) => {
        metadataMap[item.id] = item;
      });
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(metadataMap),
    };
  } catch (error) {
    console.error('Error fetching submission metadata:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to fetch metadata',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
