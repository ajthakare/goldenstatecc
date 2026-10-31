# Golden State Cricket Club (GSCC) - Project Documentation

## Project Overview

**Project Name:** Golden State Cricket Club (GSCC) / Bengals Inc.
**Type:** Cricket club website with a member portal, player app and admin system
**Organization:** Bengals Inc. - 501(c)(3) non-profit organization (EIN: 93-4696065)
**Location:** Bay Area, California (8 counties: San Jose, Sunnyvale, Fremont, Milpitas, Livermore, Morgan Hill, Tracy, Davis)

**Technology Stack:**
- **Framework**: Astro.js v5.17.1, server-rendered on Netlify (`@astrojs/netlify`)
- **Styling**: Tailwind CSS v4 (utility-first CSS framework)
- **UI Components**: Astro components with inline scripts (React v19 integration installed, unused)
- **Backend**: Netlify Functions (serverless functions for API endpoints)
- **Storage**: Netlify Blobs (key-value storage for data persistence)
- **Authentication**: JWT-based sessions with role-based access control
- **Deployment**: Netlify (Functions, scheduled functions, Blobs, Forms, CDN)
- **Font**: Inter Variable (modern sans-serif)
- **CSV Processing**: PapaParse v5.5.3
- **Other**: `web-push` (notifications), `@anthropic-ai/sdk` (Rules Assistant), `puppeteer-core` + `@sparticuz/chromium` (live-score scraper), Vitest + Playwright (tests)

## Project Structure

```
goldenstatecc/
├── src/
│   ├── pages/                      # File-based routes (all server-rendered: prerender = false)
│   │   ├── index.astro             # Homepage
│   │   ├── aboutus/                # club.astro, non-profit.astro, sponsorships.astro
│   │   ├── teams.astro, members.astro, gallery.astro, contact.astro, documents.astro
│   │   ├── fixtures.astro          # Public schedule + umpiring duties
│   │   ├── feed.astro              # Club Feed (player app home)
│   │   ├── login, logout, register, forgot-password, app.astro   # Member auth + player PWA entry
│   │   ├── profile, myfixtures, mypractice.astro                 # Member self-service
│   │   ├── players/                # index.astro (directory), [id].astro (profile)
│   │   ├── winter-checkin.astro    # Winter Check-In + Summer feedback form (direct URL only)
│   │   ├── scoreboard.astro        # CricClubs live-score tester (unlisted)
│   │   ├── styleguide.astro        # Design reference (unlisted)
│   │   └── admin/                  # Admin panel (see Admin System)
│   ├── layouts/                    # Layout.astro (public + member), AdminLayout.astro
│   ├── components/                 # Header/Footer, PWA top/bottom navs (player + admin),
│   │   │                           # sponsor cards, SocialFeedViewer, UmpiringDutyCard, ...
│   │   ├── feed/FeedItemCard.astro
│   │   └── profile/                # BadgeList, PlayerAvatar, ProfileSummary
│   ├── data/                       # documents.ts, ncca-rules.json (Rules Assistant)
│   ├── middleware/auth.ts          # Sessions, password hashing, role helpers
│   ├── types/                      # player.ts, profile.ts, social.ts, umpiring.ts, winter.ts
│   ├── utils/                      # badges, feed, duty-suggestions, umpiring, teamColors, auditLog, ...
│   ├── styles/                     # globals.css, components.css, admin.css, themes/, ...
│   ├── config.ts                   # SITE_CONFIG (contact, socials, sponsors, Winter Check-In switches)
│   └── utils.ts
├── public/
│   ├── media/                      # Gallery photos (add images here!)
│   ├── documents/                  # gscc/ and ncca/ PDFs for /documents
│   ├── overlay/                    # fit.js (scales overlays to the source size), unused index.html
│   ├── sponsors/, icons/, images/, install-guide/, screenshots/
│   ├── manifest.json               # Player PWA (start_url /app)
│   ├── manifest-admin.json         # Admin PWA (start_url /admin/app, scope /admin/)
│   └── sw.js                       # Service worker (push notifications)
├── netlify/
│   ├── functions/                  # ~117 functions; `_*.ts` are shared helpers, not endpoints
│   └── edge-functions/rewrite.js   # Starter-template demo on /edge only
├── tests/                          # unit/, integration/ (Vitest), e2e/ (Playwright)
├── docs/                           # Project docs, guides, scripts/ (see Documentation)
├── local-debug/                    # 🚨 GIT-IGNORED: Debug/migration scripts (NEVER commit)
│   ├── netlify-functions/          # Debug functions (security risk if deployed)
│   ├── scripts/                    # Standalone debug/migration/restore scripts
│   └── README.md                   # Security warnings and usage guidelines
├── netlify.toml                    # Build, function bundling, headers
├── astro.config.mjs, package.json, tsconfig.json, vitest.config.ts, playwright.config.ts
└── CLAUDE.md                       # This file
```

## Site Configuration

**Global config location:** `/src/config.ts`

```typescript
export const SITE_CONFIG = {
  name: 'Golden State Cricket Club',
  contact: {
    email: 'gsbengalsinc@gmail.com',
    phone: '+1 (xxx) xxx-xxxx'
  },
  social: {
    instagram: {
      url: 'https://www.instagram.com/goldenstate_cc/',
      label: '@goldenstate_cc'
    },
    youtube: {
      url: 'https://www.youtube.com/@GoldenStateCricketClub',
      label: 'Golden State Cricket Club'
    }
  },
  nonProfit: {
    name: 'Bengals Inc.',
    status: '501(c)(3) non-profit organization',
    ein: '30-13XXXXX',
    founded: '2018',
    mission: '...',
    impactStats: [...]
  }
}
```

## Teams

- Four teams: **Tigers**, **Bulls**, **Thunder Cats**, **Bears** (full names like "Bengal Tigers" live in season data)
- Teams and divisions are set per season in `/admin/seasons`; don't hard-code them. Watch the casing of `fixture.team` (e.g. ThunderCats vs Thunder Cats) when matching
- Team pill colors: `src/utils/teamColors.ts`

**Recent Achievement:** 🏆 2025 Summer League – T20 Division 1 Champions (Bengal Tigers)

## Public Website Features

| Route | What it shows |
| :-- | :-- |
| `/` | Hero, club in numbers, recent achievements, where we play, "From the ground" strip (newest Instagram posts from the social feed, hidden if it's empty), sponsors |
| `/aboutus/club` | Story, culture and values, leadership, non-profit link |
| `/aboutus/non-profit` | 501(c)(3) mission, impact, programs, board, Zeffy donation |
| `/aboutus/sponsorships` | Tiers, current and previous sponsors |
| `/teams` | Teams with this season's divisions (`seasons-get-active`, `fixtures-list`) |
| `/members` | Membership overview and how to join |
| `/gallery` | Instagram/YouTube carousel (`social-feed-get`) + `public/media/` photo grid with lightbox |
| `/fixtures` | Upcoming weekend, upcoming and past fixtures, plus umpiring duties. Umpire names only for signed-in members |
| `/feed` | Club Feed (see below). Public; umpire names only for signed-in members |
| `/documents` | Club and NCCA PDFs (see Documents and Rules Assistant) |
| `/contact` | Contact form (Netlify Forms), contact info, socials |

## Member Portal (player self-service)

Roles: `member`, `admin`, `super_admin`. Members sign in at `/login`; admins too.

- **Register** (`/register` → `member-register`): reCAPTCHA, emergency contact required, account starts `pending`. Login is refused while pending, rejected or suspended
- **Approve / reject / suspend / reactivate** in `/admin/users` (`members-*`, super admin only). Approval links the registration to an existing player or creates one
- **Password reset** is admin-handled: `/forgot-password` → `password-reset-request`; a super admin issues a temporary password in `/admin/users` (`password-reset-complete`, then `-close` or `-reject`)
- **`/profile`**: player card, badges, edit phone/USAC ID/role/batting and bowling style/CricClubs link/emergency contact/job, privacy (show phone, show company), password, photo (cropped in browser; 400px + 240px copies via `profile-photo`)
- **`/myfixtures`**: club fixtures in the next 7 days for all teams, with who's available. Members can vote (available yes/no) only for their own roster teams (`member-fixtures-list`, `member-availability-update`)
- **`/mypractice`**: practices in the next 30 days; reply yes / bowling only / not available, plus extra players (`practice-list`, `practice-availability-update`)
- **`/players`** directory and **`/players/[id]`** profiles: members only; privacy applied server-side (`players-directory`, `player-profile-get`, photos via `player-avatar`)
- **Badges** (`src/utils/badges.ts`): captain, vice-captain, POTM, matches, ever-present, duty, umpired, practice regular. Stats are stored; badges are derived on every read, so thresholds can change without recalculating

## Player PWA vs Admin PWA

- **Player app**: `public/manifest.json`, start URL `/app` → `/feed` if signed in, else `/login`. Bottom nav (`PWABottomNav.astro`): Feed, Fixtures, My Fixtures, Practice, Players, Profile
- **Admin app**: `public/manifest-admin.json`, start URL `/admin/app`, scope `/admin/` → `/admin/availability` for admins. Bottom nav (`AdminPWABottomNav.astro`): Availability, Players, Practices, Statistics, Notifications, Rules, Stream
- Both share `public/sw.js` (push handling). `/sw.js` is served `no-cache`

## Club Feed (`/feed`)

- Results, Player of the Match, milestones, new badges, upcoming fixtures and umpiring duties, Instagram/YouTube posts
- `/feed` only reads the stored copy at `player-profiles/club-feed`, rebuilt every 6h by `schedule-club-feed` (15 min after `sync-social-feed`). If a source can't be read, the previous copy stays. Don't build the feed per request
- `club-feed-get` builds it live; used by Admin → Club Feed and profile "Recent activity"
- Admins hide/unhide any post at `/admin/feed` (`feed-hide`); that patches the stored copy straight away

## Push Notifications

- Web Push via VAPID keys (`web-push`). Members subscribe (`push-subscribe`, `push-unsubscribe`); subscriptions in `push-subscriptions`
- `/admin/notifications`: presets, title/body/link, preview, subscriber count (`push-send`, `push-subscriber-count`). Can target specific player IDs
- Players newly assigned to an upcoming umpiring duty get a push (`umpiring-duties-update`)

## Scheduled Jobs (`schedule()` in `netlify/functions/`)

Netlify only runs these on the published deploy. Times are Pacific (cron is UTC).

| Function | When | What |
| :-- | :-- | :-- |
| `schedule-saturday` | Sat 3 PM | Creates next week's Net Practice (Wed 7 PM) and Field Practice (Fri 5 PM) if missing |
| `schedule-sunday` | Sun 8 PM | One combined push (practice votes, game votes, the week's umpiring duties) + personal reminders to assigned umpires |
| `backup-weekly` | Sun 11 PM | Snapshots the main stores to one JSON file committed to a private backups repo (`BACKUP_GITHUB_TOKEN`). Restore script is in `local-debug/scripts/` |
| `schedule-statistics` | Mon 3 AM | Recalculates admin statistics + profile stats/badges (past fixtures only) |
| `sync-social-feed` | Every 6h (:00 UTC) | Pulls Instagram + YouTube into `social-feed`; refreshes the Instagram token itself |
| `schedule-club-feed` | Every 6h (:15 UTC) | Rebuilds the stored Club Feed |
| `schedule-overlay-clear` | Sun 11 PM | Clears the stream overlay match IDs so next weekend's streams start without a ticker |

`backup-weekly` has its own store list; `player-profiles`, `winter-checkin`, `social-feed` and `stream-overlay` (match-day state) aren't in it. Add new stores there.

## Live Score and Streaming Overlays

- **`cricclubs-live-score`** (public, `?matchId=`): CricClubs blocks direct API calls, so it renders the public overlay page in headless Chromium (`@sparticuz/chromium` + `puppeteer-core`, kept out of other bundles in `netlify.toml`) and reads score, wickets, overs and target from the DOM
- **`/scoreboard`**: unlisted tester page for that endpoint
- **Stream overlays** (`src/pages/overlay/[team].astro`): one fixed link per team, `/overlay/tigers`, `bulls`, `cats` (or `thundercats`), `bears`, added once as a browser/web source in Streamlabs, Prism, OBS, ... Club/team logo, sponsors (list in that file), and the CricClubs ticker embedded once an admin sets the team's match ID at `/admin/stream`. The page polls `overlay-match-get` every 30s (one function call each, ~480 per 4-hour stream) and adds, swaps or removes the ticker without reloading
- Drawn at 1920×1080 and scaled by `public/overlay/fit.js` (CSS zoom on Android, transform elsewhere; `?debug=1` shows the measured size). The viewport is locked to `device-width`, zoom 1, or Android web views report the wrong size
- Prism on iPhone doesn't show the embedded ticker; `/admin/stream` shows the direct CricClubs link to add as a separate source there
- Match IDs: `stream-overlay` store, current state only (no history or audit), set by `overlay-match-update` (admin), cleared Sundays by `schedule-overlay-clear`

## Admin System

**Access:** `/admin` (redirects to `/admin/availability`). Pages check the role server-side; functions must also call `isCurrentAdmin` (see Add New Admin Function).

| Page | What it does |
| :-- | :-- |
| `/admin/availability` | Fixtures & Availability: per-season fixture list, results |
| `/admin/availability/[seasonId]` | Availability editor: available → selected, duties, "Suggest Duties" panel (`availability-duty-history`) |
| `/admin/fixtures` | Fixture CRUD, CSV import/export, results |
| `/admin/umpiring` | Umpiring duties: CSV import from the league sheet (upsert by Game#), up to 2 umpires, outcome and club payment tracking |
| `/admin/practices` | Practice sessions: view responses, add/remove players, extras, lock |
| `/admin/players`, `/admin/players/import` | Player pool CRUD, CSV import/export, photos |
| `/admin/roster` | Core roster: mark players as core to a team per season |
| `/admin/seasons` | Seasons, teams and divisions, active season |
| `/admin/statistics` | Season/team/career stats, CSV export, "Recalculate" (also refreshes profile badges) |
| `/admin/users` | Admins and members: promote/change role, delete, approve/suspend registrations, password resets. Most actions super admin only |
| `/admin/notifications` | Send push notifications |
| `/admin/feed` | Club Feed with hide/unhide |
| `/admin/inquiries` | Contact form submissions (Netlify Forms API) with review status (`submission-metadata`) |
| `/admin/winter-checkin`, `/admin/summer-feedback` | Winter Check-In responses and Summer feedback: list, CSV export, delete. Hidden from admins on a restricted list in `src/config.ts` |
| `/admin/rules` | Rules Assistant (see below) |
| `/admin/stream` | Live Stream: set or clear each team's CricClubs match ID for its stream overlay, copy the overlay and ticker links |
| `/admin/audit-logs` | Super admin only: browse by month, search, delete old logs |

### Winter Check-In / Summer feedback

- `/winter-checkin` (not in nav, direct URL): guests and members. Members' form includes Summer feedback (submitted together); members see and update their own response (`winter-checkin-mine`)
- Switches in `SITE_CONFIG.winterCheckIn`: `acceptingResponses` (everyone), `acceptingMemberResponses` (fallback for members). Env var `WINTER_CHECKIN_MEMBERS_OPEN=true|false` overrides the member switch without a deploy. Guests are never affected by the member switch

## Documents and Rules Assistant

### Documents page (`/documents`, public)
- PDFs live in `public/documents/gscc/` (club documents) and `public/documents/ncca/` (NCCA league rules)
- The list shown on the page is `src/data/documents.ts` (title, description per file). Pages are server-rendered and Netlify doesn't ship `public/` to functions, so the page can't read the folder at runtime
- **To add a document:** drop the PDF in the right folder and add an entry to `src/data/documents.ts`
- Linked from the header ("Others" → Documents) and the footer; not in the player app

### Rules Assistant (`/admin/rules`, admins only)
- Chat that answers NCCA rules questions with quoted clauses and links to the PDF page; also a "Rules" tab in the admin app
- `netlify/functions/rules-ask.ts` sends every PDF in `ncca/` (extracted to `src/data/ncca-rules.json`) with each question to Claude Haiku 5.5, with citations on and the documents cached for an hour
- **After changing anything in `public/documents/ncca/`**, re-run the extraction (see Run Maintenance Scripts). `tests/unit/ncca-rules.test.ts` fails if the documents list or the extracted text no longer match the PDFs
- Precedence, as the Standing Rules preamble sets it: Standing Rules → ICC playing conditions → Code of Conduct / Rain Impact Guidelines. Off-topic questions get a fixed one-line refusal
- Keep thinking on: tested without it, Haiku dropped citations and misread a clause. Answers take 2–9s, inside Netlify's 60s synchronous function limit
- Cost: the documents are ~160K tokens. About 16¢ to cache them, then about 1¢ per question within the hour (the cache is shared by all admins). Capped by a $10/month spend limit on the `gscc-rules` workspace in the Anthropic Console. The API key there expires 2027-11-03

## Data Storage Architecture

**Storage:** Netlify Blobs. Every function calls `getStore({ name, siteID: process.env.SITE_ID, token: process.env.NETLIFY_AUTH_TOKEN })`.

**Stores:**

| Store | Holds |
| :-- | :-- |
| `players` | `players-all`: every person, members and admins included (login, roles, registration status, profile, season assignments). Write via `_players-store.ts` |
| `admin-users` | Legacy admin records, still mirrored on promote/role change/delete. Login and role checks use `players` |
| `seasons` | Seasons, teams, divisions, active flag |
| `fixtures` | Fixtures per season |
| `fixture-availability` | Availability and selection per fixture |
| `core-roster` | Core players per team per season (`core-roster-<seasonId>`) |
| `practice-sessions` | Practices (`practice-<id>`) + per-season index |
| `umpiring-duties` | Umpiring duties per season (`src/utils/umpiring.ts`) |
| `player-statistics` | Calculated admin statistics (season, team, career) |
| `player-profiles` | Profile stats, feed milestones/events/hidden posts, stored Club Feed (`club-feed`) |
| `social-feed` | Merged Instagram + YouTube feed and the Instagram token |
| `stream-overlay` | Current CricClubs match ID per team for the stream overlays (`match-ids`) |
| `push-subscriptions` | One `subscriptions` list, each tagged with its player ID |
| `password-reset-requests` | Reset requests for super admins |
| `winter-checkin` | Winter Check-In + Summer feedback responses |
| `submission-metadata` | Review status for contact form submissions (the submissions themselves are in Netlify Forms) |
| `audit-logs` | Admin action audit trail, by month |

Sessions aren't stored: they're signed JWTs in a cookie.

**Concurrent writes:** use `updateJSON` / `setJSONIf` from `netlify/functions/_blobs.ts`. `@netlify/blobs` 10.5's `setJSON` ignores `onlyIfMatch`/`onlyIfNew`.

**Key Data Models:** `src/types/player.ts` (Season, Player, Fixture, availability, roster, practice), `profile.ts`, `umpiring.ts`, `social.ts`, `winter.ts`.

## Gallery System Implementation

**CRITICAL: Image Handling Pattern**

**Location:** `/public/media/`

**How it works:**
1. Images are stored in `/public/media/` folder as static assets
2. Node.js `readdir()` dynamically reads files at build time
3. Images served as direct URLs: `/media/filename.jpg`
4. Automatic detection - adding new images makes them appear automatically

**Important Technical Decision:**
- **DO NOT use Astro's Image component** for gallery images
- **DO NOT use CSS `aspect-ratio` property** - causes black box rendering issues
- **USE inline styles with explicit dimensions** and `object-fit: cover`

**Working Pattern (gallery.astro; the homepage strip now uses the Instagram feed instead):**

```typescript
// Frontmatter - Dynamic image loading
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

let galleryImages: { src: string; alt: string }[] = [];
try {
    const mediaDir = join(process.cwd(), 'public', 'media');
    const files = await readdir(mediaDir);

    galleryImages = files
        .filter(file => /\.(jpg|jpeg|png|JPG|JPEG|PNG)$/i.test(file))
        .filter(file => file !== '.DS_Store')
        .sort()
        .map(file => ({
            src: `/media/${file}`,
            alt: file.replace(/\.(jpg|jpeg|png|JPG|JPEG|PNG)$/i, '')
        }));
} catch (error) {
    console.error('Error loading gallery images:', error);
}
```

```html
<!-- Image rendering - Use explicit dimensions + object-fit -->
<div style="width: 200px; height: 200px;">
    <img
        src={image.src}
        alt={image.alt}
        width="200"
        height="200"
        style="width: 100%; height: 100%; object-fit: cover; display: block;"
    />
</div>
```

**Lightbox Implementation:**
- Modal overlay with full-size image
- Navigation arrows (prev/next)
- Keyboard support (ESC, Arrow Left, Arrow Right)
- Click background to close
- Image counter (X / Total)

**To Add New Images:**
1. Simply drop images into `/public/media/`
2. Supported formats: jpg, jpeg, png (case-insensitive)
3. Images automatically appear in the gallery page grid
4. No code changes needed

## Design System

**Color Scheme:**
- **Primary:** `#f67280` (coral pink) - brand color
- **Secondary:** `#355c7d` (blue) - complementary color
- **Accent:** `#E5C878` (gold) - highlights

**Team Colors:** `src/utils/teamColors.ts` (Tigers amber, Bulls blue, Thunder Cats purple, Bears green)

**Typography:**
- Font: Inter Variable
- Headings: Bold, varying sizes
- Body: Regular weight

**Custom CSS Classes (globals.css):**
- `.btn`, `.btn-lg` - Primary buttons
- `.btn-secondary` - Secondary buttons
- `.card`, `.card-elevated` - Card containers
- `.stat-box` - Statistics display
- `.accent-box` - Highlighted content boxes
- `.text-justified` - Responsive justified text (left on mobile, justified on desktop)
- `.page-title`, `.section-heading`, `.subsection-heading` - Heading styles
- `.text-body`, `.text-body-lg`, `.text-body-base` - Body text sizes
- `.tag` - Pill-shaped tags
- `.member-grid` - Member card grid layout

**Layout:**
- Max width: 1280px (standard container)
- Responsive breakpoints: sm (640px), md (768px), lg (1024px), xl (1280px)
- Mobile-first approach

## Available Commands

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build your production site to `./dist/`          |
| `npm run preview`         | Preview your build locally, before deploying     |
| `npm run astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `npm test`                | Vitest (unit + integration)                      |
| `npm run test:e2e`        | Playwright end-to-end tests                      |

## Common Tasks

### Add New Gallery Images
1. Add image files to `/public/media/`
2. Images automatically appear in the gallery page grid
3. No code changes needed

### Update Site Configuration
1. Edit `/src/config.ts`
2. Update contact info, social media links, or other global settings

### Create New Page
1. Create `.astro` file in `/src/pages/`
2. File-based routing: `/src/pages/example.astro` → `/example`

### Add New Admin Function
1. Create Netlify function in `/netlify/functions/`
2. Follow pattern from existing functions (auth check, Blobs operations)
3. **Check the role, not just the session:** `validateAdminSession()` accepts any signed-in user, members included. After it, call `isCurrentAdmin(session)` (or `isCurrentSuperAdmin`) from `netlify/functions/_admin-auth.ts` and return 403 if it fails. `tests/unit/admin-auth.test.ts` fails for any admin function that skips this

### Run Maintenance Scripts
```bash
# Production-safe scripts only
node docs/scripts/generate-session-secret.cjs

# Re-extract the NCCA PDFs for the Rules Assistant (needs pypdf + fonttools; see the script header)
.venv-docs/bin/python docs/scripts/extract-ncca-rules.py
```

### Run Debug Scripts (Local Only)
```bash
# Standalone scripts
node local-debug/scripts/check-blob-usage.js
node local-debug/scripts/migrate-admins-to-players.mjs

# Test Netlify functions locally (temporary)
cp local-debug/netlify-functions/check-user.ts netlify/functions/
# Access at: http://localhost:8888/.netlify/functions/check-user
rm netlify/functions/check-user.ts  # MUST remove after testing
```

### Create New Debug Script
**ALWAYS create in `/local-debug/` folder - NEVER in production folders**
```bash
# For Netlify Functions
touch local-debug/netlify-functions/debug-feature-name.ts

# For standalone scripts
touch local-debug/scripts/check-data-integrity.js

# Update documentation
# Add entry to local-debug/README.md with purpose and risks
```

## Important Technical Notes

### Local Development Uses Production Data
- `.env` holds the production `SITE_ID` and `NETLIFY_AUTH_TOKEN`, and every function passes them to `getStore()`, so a plain `netlify dev` **reads and writes production Blobs**, and can send real push notifications through the VAPID keys
- Treat local testing of anything that writes as a change to the live site. For an empty sandbox, use `local-debug/scripts/blobs-sandbox-server.mjs` with those variables blanked

### Image Rendering Issues (Historical)
- **Problem:** Astro Image component + CSS aspect-ratio = black boxes
- **Solution:** Public folder + direct URLs + inline styles
- **Never use:** `aspect-ratio` CSS property for gallery images
- **Always use:** Explicit width/height with `object-fit: cover`

### Mobile Responsiveness
- All pages are mobile-responsive
- Text justification disabled on mobile (readability)
- Gallery uses responsive grid (2/3/4 columns)
- Carousel has horizontal scroll with snap points

### Authentication
- Signed JWT in a cookie (`src/middleware/auth.ts`); nothing stored server-side
- Roles: `member`, `admin`, `super_admin`. The token carries the role from login time, so admin functions re-check the current role in `players-all` (`isCurrentAdmin`)
- 15-day session expiry
- Passwords hashed with bcrypt

### Data Integrity
- Audit logging for all admin actions
- Season-based data isolation
- Player history preserved across seasons
- Validation at both client and server levels

## Deployment

**Platform:** Netlify

**Build Settings:**
- Build command: `npm run build`
- Publish directory: `dist`

**Environment Variables:**
- `SESSION_SECRET` - Signs session cookies (generate with `docs/scripts/generate-session-secret.cjs`)
- `SITE_ID`, `NETLIFY_AUTH_TOKEN` - Netlify Blobs access (every store)
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `PUBLIC_VAPID_PUBLIC_KEY` - Push notifications
- `ANTHROPIC_API_KEY` - Rules Assistant (secret; key scoped to the `gscc-rules` workspace). `RULES_MODEL` optionally overrides the model
- `RECAPTCHA_SECRET_KEY` - Member registration captcha
- `BACKUP_GITHUB_TOKEN` - Weekly data backup
- `YOUTUBE_API_KEY` (and optional `YOUTUBE_CHANNEL_HANDLE`) - YouTube in the social feed
- `WINTER_CHECKIN_MEMBERS_OPEN`, `PUBLIC_DISABLE_UPLOADS` - Feature switches

**Netlify Features Used:**
- Functions (serverless API)
- Blobs (data storage)
- Scheduled functions (see Scheduled Jobs)
- Forms (contact form submissions)
- CDN (image delivery)

## Documentation

**Key docs in `/docs/`** (many predate the member portal; check against the code):
- `README.md` - Index of the docs folder
- `implementation/PLAYER_MANAGEMENT_PLAN.md`, `implementation/STATUS.md` - Original player-management plan and status
- `guides/` - `PLAYER_MANAGEMENT_GUIDE.md`, `AVAILABILITY_ADMIN_GUIDE.md`, `MOBILE_TESTING_GUIDE.md`, `TESTING_GUIDE.md`, `CODING_STANDARDS.md`, `DEPLOYMENT_CHECKLIST.md`, ...
- `PASSWORD_RESET_FEATURE.md`, `ADMIN_ROLE_FIXES.md`, `AUTHENTICATION_FLOW_ANALYSIS.md`, `SPONSORSHIP_IMPLEMENTATION.md`
- `scripts/` - `generate-session-secret.cjs`, `extract-ncca-rules.py`, `bootstrap-instagram-token.cjs`, `generate-admin-icons.py`, `sync-player-names.js`
- `archived/` - Superseded docs (old status, theme guides)

## Development Notes

### File Routing
- Each `.astro` file in `pages/` becomes a route
- Server-rendered pages: Add `export const prerender = false;` in frontmatter
- API endpoints: Netlify Functions in `netlify/functions/`, called at `/.netlify/functions/<name>` (some comments say `/api/<name>`)

### Component Structure
- All components are Astro (`.astro`); interactivity is inline `<script>` in pages. React is installed but no `.tsx` components exist

### Styling Approach
- Tailwind utility classes for most styling
- Custom CSS in `globals.css` for reusable patterns
- Inline styles for gallery images (critical for rendering)

### State Management
- No client-side state management library
- Server-side data fetching in page frontmatter
- Form submissions to Netlify Functions

## Security Considerations

- Password hashing with salt
- Session validation on all admin endpoints, plus a current-role check (`isCurrentAdmin`), since a valid session alone can belong to a member
- Role-based access control (RBAC)
- Input sanitization
- CSRF protection via same-origin policy
- No sensitive data in client-side code

### Debug Scripts and Security Risk Management

**🚨 CRITICAL: Debug scripts are NEVER committed to production**

**Location:** `/local-debug/` (git-ignored)

**Why this matters:**
- Scripts in `netlify/functions/` become publicly accessible at `/.netlify/functions/[script-name]`
- Debug functions often bypass authentication for quick testing
- Can expose sensitive user data or allow unauthorized modifications
- Migration scripts can alter production data if accidentally triggered

**When creating debug/migration scripts:**

1. **Always create in `/local-debug/`** - Never in `netlify/functions/` or `docs/scripts/`
2. **Folder structure:**
   - `/local-debug/netlify-functions/` - Debug Netlify Functions (highest security risk)
   - `/local-debug/scripts/` - Standalone Node.js scripts (lower risk)
3. **Naming convention:**
   - Prefix with purpose: `check-`, `fix-`, `migrate-`, `debug-`
   - Include date for migrations: `migrate-admins-2026-02.ts`
4. **Add documentation:** Update `/local-debug/README.md` with script purpose and risks

**Testing debug functions locally:**
```bash
# Temporarily copy to netlify/functions for testing
cp local-debug/netlify-functions/check-user.ts netlify/functions/
# Test at: http://localhost:8888/.netlify/functions/check-user

# MUST remove immediately after testing!
rm netlify/functions/check-user.ts
```

**Common debug script types:**
- `check-user.ts` - Query user status and roles
- `fix-admin-role.ts` - Manually update user roles
- `migrate-*.ts` - One-time data migrations
- `debug-*.ts` - Debug specific features
- `check-blob-usage.js` - Storage usage utilities

**Before every commit:**
```bash
# Verify nothing from local-debug/ is staged
git status | grep local-debug  # Should return nothing

# Check for accidentally committed debug functions
ls netlify/functions/ | grep -E "(check|fix|debug|migrate)"
```

**See `/local-debug/README.md` for complete usage guidelines and current script inventory.**

## Future Enhancements (Planned)

- Media gallery with Cloudinary integration
- Email notifications for fixtures/availability
- Advanced statistics with charts/graphs
- Physical scoreboard (ESP32 + LED strip polling `cricclubs-live-score`)

## Support

For questions or issues, contact: gsbengalsinc@gmail.com

---

**Last Updated:** October 2026
**Current Version:** 1.0 (Production)
**Astro Version:** 5.17.1
