# Admin Interface Setup Guide

This document provides step-by-step instructions for setting up and using the admin interface for the Bengals Cricket Club website.

## Overview

The admin interface allows authorized users to:
- View contact form submissions from the website
- Delete submissions
- Manage admin users (add/remove)

## Architecture

- **Frontend**: Astro pages with TypeScript
- **Backend**: Netlify Functions (serverless)
- **Authentication**: JWT-based sessions with HTTP-only cookies
- **Storage**:
  - Admin users: Netlify Blobs
  - Form submissions: Netlify Forms API
  - Submission metadata: Netlify Blobs

## Setup Instructions

### 1. Install Dependencies

Dependencies are already installed if you ran `npm install`. The admin system uses:
- `bcryptjs` - Password hashing
- `jsonwebtoken` - Session management
- `cookie` - Cookie parsing

### 2. Configure Environment Variables

#### Local Development

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and set the following variables:

   **A. Initial Admin Credentials** (temporary, for first-time setup):
   ```env
   FIRST_ADMIN_USERNAME=admin
   FIRST_ADMIN_PASSWORD=YourSecurePassword123!
   ```

   **B. Netlify Personal Access Token**:
   - Go to [Netlify User Applications](https://app.netlify.com/user/applications)
   - Click "New access token"
   - Give it a name (e.g., "Bengals CC Admin")
   - Copy the token and add to `.env`:
   ```env
   NETLIFY_AUTH_TOKEN=your_token_here
   ```

   **C. Session Secret** (for JWT signing):
   Generate a random secret with:
   ```bash
   node scripts/generate-session-secret.cjs
   ```

   Or use this one-liner:
   ```bash
   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
   ```

   Add to `.env`:
   ```env
   SESSION_SECRET=your_generated_secret_here
   ```

   **D. Environment**:
   ```env
   NODE_ENV=development
   ```

#### Production (Netlify)

1. Go to your Netlify site dashboard
2. Navigate to **Site settings** → **Environment variables**
3. Add the following variables:
   - `NETLIFY_AUTH_TOKEN` (your Personal Access Token)
   - `SESSION_SECRET` (same random secret as local)
   - `NODE_ENV` = `production`

**Note**: `SITE_ID` is automatically provided by Netlify and doesn't need to be set manually.

### 3. Create First Admin User

There used to be a `setup-first-admin` Netlify Function for this, but it had no authentication check — anyone who found the URL could call it, so it's been removed.

If admins already exist on your site, use the in-app flow instead:

1. Log in as an existing `super_admin`.
2. Go to `/admin/users` and create the new admin from there.

If you're bootstrapping a brand-new site with zero admins, write a small one-off script under `/local-debug/scripts/` that calls `hashPassword()` from `src/middleware/auth.ts` and writes directly to the `admin-users` Blobs store, run it locally, then delete it. Never add a network-reachable endpoint for this — see the "Debug Scripts" section in `CLAUDE.md`.

### 4. Access the Admin Interface

1. Navigate to `/admin` on your site:
   - Local: `http://localhost:4321/admin`
   - Production: `https://your-site.netlify.app/admin`

2. You'll be redirected to the login page

3. Log in with your first admin credentials:
   - Username: (the value you set in `FIRST_ADMIN_USERNAME`)
   - Password: (the value you set in `FIRST_ADMIN_PASSWORD`)

4. You should be redirected to the admin dashboard

### 5. Add Additional Admin Users

Once logged in as the first admin:

1. Click "Manage Users" in the header
2. Fill in the form with a new username and password
3. Click "Add Admin User"
4. The new user can now log in with their credentials

### 6. Test the System

1. **Test login/logout**:
   - Log out and log back in
   - Try incorrect credentials (should show error)

2. **Test submissions viewing**:
   - Go to `/contact` on your website
   - Fill out and submit the contact form
   - Go to `/admin` and verify the submission appears

3. **Test submission deletion**:
   - Click "View" on a submission
   - Click "Delete" and confirm
   - Verify it's removed from the list

4. **Test user management**:
   - Add a new admin user
   - Log out and log in with the new user
   - Try to delete a user (should prevent deleting self or last admin)

## Usage

### Admin Dashboard (`/admin`)

The main dashboard shows all contact form submissions:

- **Search**: Filter submissions by name, email, or message content
- **View**: Click any row or "View" button to see full submission details
- **Delete**: In the detail modal, click "Delete" to remove a submission
- **Refresh**: Reload submissions from Netlify

### Manage Users (`/admin/users`)

Add or remove admin users:

- **Add User**: Fill in username and password (8+ chars)
- **Delete User**: Click "Delete" next to any user
  - Cannot delete yourself
  - Cannot delete the last admin

### Logout

Click "Logout" in the header to end your session.

## Security Features

- **Password Hashing**: All passwords hashed with bcrypt (10 rounds)
- **HTTP-Only Cookies**: Session tokens stored in secure, HTTP-only cookies
- **SameSite Strict**: CSRF protection via cookie settings
- **Secure Flag**: Cookies only sent over HTTPS in production
- **Session Expiration**: Sessions expire after 24 hours
- **Server-Side Validation**: All admin routes protected on server
- **Environment Variables**: Secrets never in Git or client-side code
- **Netlify Blobs**: Admin credentials stored securely, not in code

## Troubleshooting

### "Unauthorized" error on admin pages

- Check that you're logged in (go to `/admin/login`)
- Check that your session hasn't expired (log out and log back in)
- Verify environment variables are set correctly

### "NETLIFY_AUTH_TOKEN not configured" error

- Ensure `NETLIFY_AUTH_TOKEN` is set in your environment variables
- For local development, check `.env` file
- For production, check Netlify site settings

### "Failed to fetch submissions" error

- Verify your Netlify Personal Access Token is valid
- Check that the contact form exists and is named "contact"
- Check Netlify Functions logs for detailed errors

### Cannot log in with first admin credentials

- Verify the first admin was created successfully in the `admin-users` Blobs store
- Check that the username/password match what you're entering

### "SESSION_SECRET environment variable is not set" error

- Generate a session secret with: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`
- Add it to `.env` (local) and Netlify environment variables (production)

### Local development with Netlify Functions

Use `netlify dev` instead of `npm run dev` to test Netlify Functions locally:

```bash
netlify dev
```

This will start the dev server at `http://localhost:8888` with Functions support.

## File Structure

```
src/
├── pages/
│   └── admin/
│       ├── index.astro          # Admin dashboard (submissions)
│       ├── login.astro          # Login page
│       ├── logout.astro         # Logout handler
│       └── users.astro          # User management
└── middleware/
    └── auth.ts                  # Auth utilities

netlify/
└── functions/
    ├── auth-login.ts            # Login endpoint
    ├── auth-check.ts            # Session validation
    ├── get-submissions.ts       # Fetch submissions
    ├── update-submission.ts     # Delete/update submissions
    ├── admin-users-list.ts      # List admin users
    ├── admin-users-create.ts    # Create admin user
    └── admin-users-delete.ts    # Delete admin user
```

## API Endpoints

All endpoints are serverless functions deployed to `/.netlify/functions/`:

### Authentication
- `POST /auth-login` - Log in with username/password
- `GET /auth-check` - Check if session is valid

### Submissions
- `GET /get-submissions?page=1&per_page=50` - Fetch submissions
- `POST /update-submission` - Delete or update submission status

### Admin Users
- `GET /admin-users-list` - List all admin users
- `POST /admin-users-create` - Create new admin user
- `POST /admin-users-delete` - Delete admin user

## Future Enhancements

Potential features to add later:

- Email notifications for new submissions
- Export submissions to CSV
- Bulk operations on submissions
- Admin activity logs
- Advanced filtering (date range, status)
- Dashboard analytics (submission trends)
- Mark submissions as read/archived (UI already supports it)
- Two-factor authentication (2FA)
- Password reset functionality
- Rate limiting on login attempts

## Support

For issues or questions, contact the development team or refer to:
- [Netlify Forms API Docs](https://docs.netlify.com/api/get-started/#forms)
- [Netlify Functions Docs](https://docs.netlify.com/functions/overview/)
- [Netlify Blobs Docs](https://docs.netlify.com/blobs/overview/)
