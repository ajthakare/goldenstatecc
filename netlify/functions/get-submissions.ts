import { Handler, HandlerEvent, HandlerContext } from '@netlify/functions';
import { validateAdminSession } from '../../src/middleware/auth';
import { isCurrentAdmin } from './_admin-auth';

interface NetlifySubmission {
  id: string;
  number: number;
  email: string;
  name: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  created_at: string;
  data: {
    [key: string]: string;
  };
  form_id: string;
  form_name: string;
  site_url: string;
}

/**
 * Fetch contact form submissions from Netlify Forms API
 * GET /api/get-submissions?page=1&per_page=50
 * Requires: Valid admin session
 * Returns: Array of submissions
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

    // Get query parameters
    const params = event.queryStringParameters || {};
    const page = params.page || '1';
    const perPage = params.per_page || '50';

    // Get Netlify auth token from environment
    const netlifyToken = process.env.NETLIFY_AUTH_TOKEN;
    if (!netlifyToken) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'NETLIFY_AUTH_TOKEN not configured',
        }),
      };
    }

    // Get site ID from environment (automatically set by Netlify)
    const siteId = process.env.SITE_ID;
    if (!siteId) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'SITE_ID not available',
        }),
      };
    }

    // First, get the form ID by listing all forms
    const formsResponse = await fetch(
      `https://api.netlify.com/api/v1/sites/${siteId}/forms`,
      {
        headers: {
          Authorization: `Bearer ${netlifyToken}`,
        },
      }
    );

    if (!formsResponse.ok) {
      const errorText = await formsResponse.text();
      console.error('Failed to fetch forms:', errorText);
      return {
        statusCode: formsResponse.status,
        body: JSON.stringify({
          error: 'Failed to fetch forms from Netlify',
          details: errorText,
        }),
      };
    }

    const forms = await formsResponse.json();
    const contactForm = forms.find(
      (f: { name: string }) => f.name === 'contact'
    );

    if (!contactForm) {
      return {
        statusCode: 404,
        body: JSON.stringify({
          error: 'Contact form not found',
          availableForms: forms.map((f: { name: string }) => f.name),
        }),
      };
    }

    // Now fetch submissions for this form
    const submissionsUrl = `https://api.netlify.com/api/v1/forms/${contactForm.id}/submissions?page=${page}&per_page=${perPage}`;
    const submissionsResponse = await fetch(submissionsUrl, {
      headers: {
        Authorization: `Bearer ${netlifyToken}`,
      },
    });

    if (!submissionsResponse.ok) {
      const errorText = await submissionsResponse.text();
      console.error('Failed to fetch submissions:', errorText);
      return {
        statusCode: submissionsResponse.status,
        body: JSON.stringify({
          error: 'Failed to fetch submissions from Netlify',
          details: errorText,
        }),
      };
    }

    const submissions: NetlifySubmission[] = await submissionsResponse.json();

    // Format submissions for frontend
    const formattedSubmissions = submissions.map((sub) => ({
      id: sub.id,
      number: sub.number,
      name: sub.data.name || sub.name || '',
      email: sub.data.email || sub.email || '',
      phone: sub.data.phone || '',
      message: sub.data.message || '',
      createdAt: sub.created_at,
      formName: sub.form_name,
    }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        submissions: formattedSubmissions,
        page: parseInt(page),
        perPage: parseInt(perPage),
        total: formattedSubmissions.length,
      }),
    };
  } catch (error) {
    console.error('Error fetching submissions:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      }),
    };
  }
};
