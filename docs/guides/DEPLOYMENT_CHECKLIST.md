# Admin Interface Deployment Checklist

Use this checklist to ensure everything is set up correctly before and after deployment.

## Pre-Deployment Checklist

### Local Setup
- [ ] Dependencies installed (`npm install`)
- [ ] `.env` file created from `.env.example`
- [ ] Session secret generated (`node scripts/generate-session-secret.cjs`)
- [ ] Netlify Personal Access Token obtained
- [ ] All environment variables set in `.env`:
  - [ ] `NETLIFY_AUTH_TOKEN`
  - [ ] `SESSION_SECRET`
  - [ ] `NODE_ENV=development`
- [ ] Build succeeds locally (`npm run build`)
- [ ] No TypeScript errors
- [ ] No build warnings

### Code Review
- [ ] All admin pages use `export const prerender = false`
- [ ] All Netlify functions properly typed
- [ ] Authentication middleware complete
- [ ] Password hashing implemented (bcrypt)
- [ ] JWT session management working
- [ ] HTTP-only cookies configured
- [ ] Security headers set correctly

### Git & Version Control
- [ ] All files committed to Git
- [ ] `.env` is in `.gitignore` (should already be)
- [ ] No secrets in committed code
- [ ] Meaningful commit message
- [ ] Pushed to remote repository

## Deployment Checklist

### Netlify Configuration
- [ ] Site connected to Git repository
- [ ] Build command: `npm run build`
- [ ] Publish directory: `dist`
- [ ] Node version: 20.x or higher
- [ ] Auto-deploy enabled

### Environment Variables (Netlify Dashboard)
Navigate to: **Site settings** → **Environment variables**

- [ ] `NETLIFY_AUTH_TOKEN` set (same as local)
- [ ] `SESSION_SECRET` set (same as local)
- [ ] `NODE_ENV` set to `production` (not development!)

### Deploy & Verify
- [ ] Deployment triggered (automatic or manual)
- [ ] Build completed successfully
- [ ] No build errors or warnings
- [ ] Site is live and accessible
- [ ] Static pages load (homepage, contact, etc.)
- [ ] Admin pages redirect correctly

## Post-Deployment Checklist

### First Admin Setup
- [ ] Setup function called: `curl -X POST https://your-site.netlify.app/.netlify/functions/setup-first-admin`
- [ ] Success message received
- [ ] First admin user created in Netlify Blobs

### Authentication Testing
- [ ] Login page loads: `/admin/login`
- [ ] Login with correct credentials → Success
- [ ] Login with wrong credentials → Error displayed
- [ ] Redirected to dashboard after login
- [ ] Dashboard displays correctly
- [ ] Logout works → Redirected to login
- [ ] Cannot access `/admin` when logged out → Redirected to login

### Submissions Testing
- [ ] Submit test form at `/contact`
- [ ] Submission appears in admin dashboard
- [ ] Submission details modal opens correctly
- [ ] Email and phone links work (click-to-email, click-to-call)
- [ ] Search/filter works
- [ ] Refresh button reloads data
- [ ] Delete submission works
- [ ] Confirmation dialog appears before delete

### User Management Testing
- [ ] Navigate to "Manage Users" page
- [ ] Current admin user appears in list
- [ ] Add new admin user → Success
- [ ] New user appears in list with timestamp
- [ ] Logout and login with new user → Works
- [ ] Delete new user → Success
- [ ] Cannot delete self → Error/disabled
- [ ] Cannot delete last admin → Error/disabled
- [ ] Invalid username shows error
- [ ] Weak password shows error

### Security Verification
- [ ] Cookies are HTTP-only (check browser DevTools)
- [ ] Cookies have Secure flag in production
- [ ] Cookies have SameSite=Strict
- [ ] Session expires after 24 hours
- [ ] Cannot access admin functions via API without auth
- [ ] Passwords are hashed in Netlify Blobs (not plain text)
- [ ] Session secret is not exposed client-side
- [ ] Netlify token is not exposed client-side

### Mobile Testing
- [ ] Login page responsive on mobile
- [ ] Dashboard responsive on mobile
- [ ] Table scrolls horizontally if needed
- [ ] Modal works on mobile
- [ ] User management works on mobile
- [ ] All buttons accessible

### Browser Testing
Test on multiple browsers:
- [ ] Chrome/Edge
- [ ] Firefox
- [ ] Safari
- [ ] Mobile Safari (iOS)
- [ ] Mobile Chrome (Android)

### Error Handling
- [ ] Network errors display user-friendly messages
- [ ] API errors are caught and displayed
- [ ] Loading states show during API calls
- [ ] Empty states display when no data
- [ ] 404 pages work for invalid routes

## Maintenance Checklist

### Regular Checks (Weekly)
- [ ] Review submission count
- [ ] Check for failed submissions
- [ ] Verify all admins are still active
- [ ] Review Netlify function logs for errors

### Security (Monthly)
- [ ] Rotate session secret
- [ ] Review admin user list
- [ ] Remove inactive admins
- [ ] Check for suspicious login attempts
- [ ] Verify Netlify token is still valid

### Updates (Quarterly)
- [ ] Update dependencies (`npm update`)
- [ ] Test all functionality after updates
- [ ] Review and update documentation
- [ ] Check for security advisories

## Optional: Production Hardening

### After First Admin Created
For extra security, remove these environment variables from Netlify:
- [ ] `FIRST_ADMIN_USERNAME` (no longer needed)
- [ ] `FIRST_ADMIN_PASSWORD` (no longer needed)

Keep them in local `.env` for development/testing.

### Add Rate Limiting (Future Enhancement)
- [ ] Implement login attempt tracking
- [ ] Add lockout after failed attempts
- [ ] Add CAPTCHA to login form

### Enable Logging (Recommended)
- [ ] Set up Netlify function logs monitoring
- [ ] Configure alerts for errors
- [ ] Track admin actions (future feature)

## Rollback Plan

If something goes wrong:

1. **Immediate Issues**:
   - Revert to previous Git commit
   - Trigger new deployment
   - Verify old version works

2. **Authentication Issues**:
   - Re-run setup function
   - Check environment variables
   - Clear browser cookies

3. **Data Issues**:
   - Submissions are safe in Netlify Forms
   - Admin users in Netlify Blobs
   - Can manually recover if needed

## Support & Troubleshooting

If issues arise, check:
1. `ADMIN_SETUP.md` - Detailed troubleshooting section
2. Netlify function logs - Real-time error messages
3. Browser console - Client-side errors
4. Network tab - API call failures

## Sign-Off

Deployment completed by: ________________

Date: ________________

Initial admin username: ________________

All tests passed: [ ] Yes [ ] No

Notes:
_________________________________________________________________
_________________________________________________________________
_________________________________________________________________

---

**Deployment Status**:
- [ ] Ready for Production
- [ ] Needs Review
- [ ] Testing in Progress
