# Golden State Cricket Club (GSCC)

The public website and team management system for the **Golden State Cricket Club**, run by Bengals Inc., a 501(c)(3) non-profit cricket club in the Bay Area, California.

The site covers two audiences:

- **Public pages** — club info, fixtures, photo gallery, non-profit/donation info, and a contact form.
- **Admin panel** (`/admin`) — season, fixture, player, roster, and availability management, plus statistics and audit logs, for club admins.

## Tech Stack

- [Astro.js](https://astro.build/) v5, server-rendered
- [Tailwind CSS](https://tailwindcss.com/) v4
- Astro components with inline scripts (React is installed but unused)
- [Netlify Functions](https://docs.netlify.com/functions/overview/) for the API
- [Netlify Blobs](https://docs.netlify.com/blobs/overview/) for data storage
- JWT-based authentication for the admin panel

## Project Structure

```
src/
├── pages/           # File-based routes — public pages and /admin/*
├── layouts/         # Page layouts (public + admin)
├── components/      # Reusable Astro/React components
├── middleware/       # Auth helpers
├── types/           # Shared TypeScript types
└── config.ts        # Site-wide configuration (contact info, socials, etc.)

netlify/
├── functions/       # Serverless API endpoints
└── edge-functions/  # Edge middleware

public/media/        # Gallery images — drop a file in here and it appears on the site
tests/                # Unit, integration, and e2e (Playwright) tests
docs/                 # Project documentation and guides
```

See [CLAUDE.md](CLAUDE.md) for a full breakdown of the codebase, data model, and conventions.

## Developing Locally

This section is written for people **and AI coding agents** (Claude Code, ChatGPT/Codex, Cursor, Copilot, ...). Follow it top to bottom to set up the repo, start the server, put test data in, and check your change. Read [CLAUDE.md](CLAUDE.md) as well: it maps the codebase, data model and conventions in detail.

### Quick start

```bash
npm install -g netlify-cli
```

```bash
git clone https://github.com/ajthakare/goldenstatecc.git && cd goldenstatecc && npm install
```

```bash
node docs/scripts/generate-session-secret.cjs
```

Put the `SESSION_SECRET=...` line it prints into a new `.env` file in the project root. Then:

- **Changing only how a page looks?** Run `npm run dev` and open http://localhost:4321.
- **Anything that needs data** (sign-in, fixtures, availability, admin)? Set up the [sandbox](#sandbox-a-private-local-database) once, then run `bash local-debug/scripts/netlify-dev-sandbox.sh` and open http://localhost:8888.

### What Netlify is (and why you don't need an account)

[Netlify](https://www.netlify.com/) hosts the live site and gives the code three things:

| Piece | What it is | In the code |
| :-- | :-- | :-- |
| **Hosting** | Serves the Astro pages | `src/pages/` |
| **Functions** | Small server endpoints the pages call at `/.netlify/functions/<name>` (sign-in, fixtures, availability, ...) | `netlify/functions/` (files starting with `_` are shared helpers, not endpoints) |
| **Blobs** | A key-value database holding everything: players, seasons, fixtures, practices, ... | Functions call `getStore({ name, ... })` |

Locally, the free **Netlify CLI** stands in for Netlify: `netlify dev` runs the Astro pages *and* the functions together on http://localhost:8888. No `netlify login` or `netlify link` is needed. The database is replaced by the sandbox below.

| Command | Serves | Functions? | Use it for |
| :-- | :-- | :-- | :-- |
| `npm run dev` | http://localhost:4321 | No: anything calling `/.netlify/functions/` fails | Styling and static page content |
| `bash local-debug/scripts/netlify-dev-sandbox.sh` | http://localhost:8888 | Yes, against the sandbox | Everything else |

### Prerequisites

- [Node.js](https://nodejs.org/) 20 (what Netlify builds with). With [nvm](https://github.com/nvm-sh/nvm): `nvm install 20`
- [Git](https://git-scm.com/)
- Netlify CLI: `npm install -g netlify-cli` (check with `netlify --version`)

### Environment variables (`.env`)

Only one is needed locally:

```
SESSION_SECRET=<value printed by: node docs/scripts/generate-session-secret.cjs>
```

Without it, sign-in fails with "SESSION_SECRET environment variable is not set". `.env` is git-ignored: never commit it. The other variables in `.env.example` (push notifications, Rules Assistant, backups, YouTube) are for the live site. Leave them out and those features just won't work locally.

> ⚠️ **Never put the production `SITE_ID` and `NETLIFY_AUTH_TOKEN` in `.env`.** Every function passes them to `getStore()`, so with them set, a plain `netlify dev` reads and writes the **live club data** (and the push keys send real notifications). The sandbox script blanks them as a safety net.

### Sandbox: a private local database

Use the sandbox whenever you need to test something locally that reads or writes data. It's an empty Netlify Blobs server on your machine (port 8971) that saves to `.netlify/blobs-sandbox/`. Nothing leaves your machine.

It's three files in `local-debug/`. That folder is **git-ignored on purpose** (it holds local-only tools that must never be deployed), so create the files yourself, once:

```bash
mkdir -p local-debug/scripts
```

`local-debug/scripts/blobs-sandbox-server.mjs`: the local Blobs server.

```js
import { BlobsServer } from '@netlify/blobs/server';

const port = 8971;
const token = 'sandbox';
const directory = process.argv[2] || '.netlify/blobs-sandbox';
const server = new BlobsServer({ directory, port, token });
await server.start();
console.log(`Blobs sandbox on http://localhost:${port} (data: ${directory})`);
```

`local-debug/scripts/sandbox-preload.cjs`: loaded into every function, it points `getStore()` at the local server.

```js
const context = { edgeURL: 'http://localhost:8971', uncachedEdgeURL: 'http://localhost:8971', siteID: 'sandbox-site', token: 'sandbox' };
globalThis.netlifyBlobsContext = Buffer.from(JSON.stringify(context)).toString('base64');
```

`local-debug/scripts/netlify-dev-sandbox.sh`: starts both, with the production keys blanked.

```bash
#!/bin/bash
cd "$(dirname "$0")/../.."
node local-debug/scripts/blobs-sandbox-server.mjs .netlify/blobs-sandbox &
SANDBOX_PID=$!
trap 'kill $SANDBOX_PID 2>/dev/null' EXIT
sleep 1
SITE_ID= NETLIFY_AUTH_TOKEN= VAPID_PRIVATE_KEY= \
  NODE_OPTIONS="--require $(pwd)/local-debug/scripts/sandbox-preload.cjs" \
  netlify dev --offline
```

Start the site with it (Ctrl+C stops both):

```bash
bash local-debug/scripts/netlify-dev-sandbox.sh
```

Open http://localhost:8888. Data stays in `.netlify/blobs-sandbox/` between runs. To start again from empty, stop the server and delete that folder:

```bash
rm -rf .netlify/blobs-sandbox
```

### Adding data to the sandbox

The sandbox starts empty. Run these in a **second terminal** from the project root while the site is running. All of them only talk to `localhost`.

#### 1. Create logins (needed first)

Nobody can sign in to an empty sandbox, so write accounts straight into the `players` store. This creates a super admin and a member, both with the password `change-me-locally` (made-up, sandbox-only accounts):

```bash
node --input-type=module -e "
import { getStore } from '@netlify/blobs';
import bcrypt from 'bcryptjs';
const store = getStore({ name: 'players', siteID: 'sandbox-site', token: 'sandbox', edgeURL: 'http://localhost:8971' });
const players = (await store.get('players-all', { type: 'json' })) || [];
const hash = await bcrypt.hash('change-me-locally', 10);
const now = new Date().toISOString();
const person = (id, firstName, lastName, email, role_auth) => ({ id, firstName, lastName, email, passwordHash: hash, role_auth,
  role: 'Batsman', isActive: true, registrationStatus: 'approved', emergencyContactName: 'Local Contact',
  emergencyContactNumber: '555-0100', createdAt: now, updatedAt: now, createdBy: 'setup', updatedBy: 'setup' });
players.push(person('local-admin', 'Local', 'Admin', 'admin@example.test', 'super_admin'));
players.push(person('local-member', 'Local', 'Member', 'member@example.test', 'member'));
await store.set('players-all', JSON.stringify(players));
console.log('Created admin@example.test and member@example.test (password: change-me-locally)');
"
```

`role_auth` is `member`, `admin` or `super_admin`. Sign in at http://localhost:8888/login.

#### 2. Add data through the admin panel (easiest)

Signed in as the admin:

1. **/admin/seasons**: create a season with its teams and divisions, then make it **active** (most pages show the active season)
2. **/admin/players**: add players, or import a CSV at **/admin/players/import**
3. **/admin/roster**: put players on a team for the season (members can only vote for their own roster team)
4. **/admin/fixtures**: add fixtures one by one or import a CSV
5. **/admin/practices**, **/admin/umpiring**: practices and umpiring duties

#### 3. Add data through the API (scriptable, good for agents)

Admin pages call the same functions you can call with `curl`. Sign in once to save the session cookie, then send JSON. Responses look like `{ "success": true, "data": { "id": "...", ... } }`.

```bash
B=http://localhost:8888/.netlify/functions
```

```bash
curl -s -c cookies.txt -H 'Content-Type: application/json' -d '{"email":"admin@example.test","password":"change-me-locally"}' $B/auth-login
```

```bash
SEASON=$(curl -s -b cookies.txt -H 'Content-Type: application/json' -d '{"name":"Winter 2026-27 (local)","startDate":"2026-10-01","endDate":"2027-03-31","teams":[{"teamName":"GSCC Tigers","division":"WB-D2"},{"teamName":"GSCC Bulls","division":"WB-D2"}]}' $B/seasons-create | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.id')
```

```bash
curl -s -b cookies.txt -X PUT -H 'Content-Type: application/json' -d "{\"id\":\"$SEASON\",\"isActive\":true}" $B/seasons-update
```

```bash
PLAYER=$(curl -s -b cookies.txt -H 'Content-Type: application/json' -d '{"firstName":"Asha","lastName":"Rao","email":"asha@example.test","role":"Batsman","isActive":true}' $B/players-create | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.id')
```

```bash
curl -s -b cookies.txt -H 'Content-Type: application/json' -d "{\"playerId\":\"$PLAYER\",\"teamName\":\"GSCC Tigers\",\"seasonId\":\"$SEASON\",\"isCore\":true}" $B/core-roster-update
```

```bash
curl -s -b cookies.txt -H 'Content-Type: application/json' -d "{\"seasonId\":\"$SEASON\",\"gameNumber\":\"101\",\"date\":\"2026-12-05\",\"time\":\"8:45 AM\",\"team\":\"GSCC Tigers\",\"opponent\":\"Sunnyvale Strikers\",\"venue\":\"Ortega Park\",\"division\":\"WB-D2\"}" $B/fixtures-create
```

Check it: `curl -s $B/fixtures-public` lists the active season and its fixtures. To find any other endpoint's request body, open `netlify/functions/<name>.ts`: most have a comment at the top listing the method and body fields.

#### 4. Write to a store directly (advanced)

For data with no API (or bulk data), read and write a store with `getStore` the same way as step 1. Store names and keys are listed in the "Data Storage Architecture" section of [CLAUDE.md](CLAUDE.md), and the record shapes are in `src/types/` (`player.ts`, `umpiring.ts`, ...). For example, `seasons` holds `seasons-list` and `active-season`; `fixtures` holds `fixtures-<seasonId>`. Prefer the API where one exists: it validates input and keeps related keys in step.

### Testing flows

With the sandbox running and the data above in place:

| Flow | How to test |
| :-- | :-- |
| Public pages | Visit `/`, `/teams`, `/fixtures`, `/gallery`, `/documents` signed out |
| Sign-in / sign-out | `/login` as admin or member, `/logout` |
| Registration + approval | Register at `/register` (Google's test reCAPTCHA is used locally), then approve it as the super admin at `/admin/users` |
| Member availability | As a member on a roster team: `/myfixtures`, vote yes/no on a fixture in the next 7 days |
| Admin selection | `/admin/availability` → pick the season → mark available players as selected, assign duties |
| Practices | Create one at `/admin/practices`, reply as a member at `/mypractice` |
| Profiles and directory | `/profile` (edit details, photo), `/players`, `/players/<id>` as a member |
| Statistics | `/admin/statistics` → "Recalculate" (counts past fixtures with results) |
| Umpiring | `/admin/umpiring`, then `/fixtures` shows duties |
| Club Feed | `/feed` reads a stored copy rebuilt every 6 hours, so it's empty locally. `/admin/feed` builds it live |

Automated tests:

| Command | What it runs |
| :-- | :-- |
| `npm test` | Vitest unit + integration tests (`tests/unit`, `tests/integration`). No server needed. Run before every pull request |
| `npm run test:e2e` | Playwright browser tests (`tests/e2e`). Starts `npm run dev` itself. First time: `npm run playwright:install` |

Some unit tests enforce project rules, for example that every admin function checks the current role (`tests/unit/admin-auth.test.ts`) and that functions read the session with `sessionFromHeaders` (`tests/unit/session-from-headers.test.ts`). If one fails, read it: it explains the rule.

### Rules for AI agents (and people)

- **Read [CLAUDE.md](CLAUDE.md) first.** It describes every page, function, store and convention.
- **Never use production credentials.** Test locally against the sandbox only.
- **Never commit `local-debug/`, `.env`, `cookies.txt` or `.netlify/`.** Debug and seed scripts go in `local-debug/` (git-ignored), never in `netlify/functions/`: every file there becomes a public URL when deployed.
- **New admin endpoints** must call `sessionFromHeaders()` and then `isCurrentAdmin()` (see "Add New Admin Function" in CLAUDE.md).
- **Concurrent writes** to a store use `updateJSON` / `setJSONIf` from `netlify/functions/_blobs.ts`.
- **Run `npm test`** and check the change in the browser on the sandbox before opening a pull request.

### What doesn't work locally

These need keys or services that only the live site has. They fail quietly or show an error, which is expected:

- Push notifications (`VAPID_*` keys)
- Rules Assistant at `/admin/rules` (`ANTHROPIC_API_KEY`)
- Instagram / YouTube feed (the gallery and homepage strip look empty)
- Contact form submissions (Netlify Forms only run on the live site)
- Scheduled jobs (Netlify runs them only on the live site; see "Scheduled Jobs" in CLAUDE.md)

### Troubleshooting

| Problem | Fix |
| :-- | :-- |
| `EADDRINUSE` / port in use | A previous run is still going. Find it with `lsof -i :8888` (or `:8971`, `:4321`) and stop it |
| "SESSION_SECRET environment variable is not set" | `.env` is missing or not in the project root |
| "Invalid credentials" | Create the logins (step 1 above) while the site is running. Repeated wrong passwords lock the account for a while; `rm -rf .netlify/blobs-sandbox` resets everything |
| Pages load but have no data, or functions return 404 | You're on `localhost:4321` (`npm run dev`). Use the sandbox script and `localhost:8888` |
| `netlify: command not found` | `npm install -g netlify-cli`, or replace `netlify dev` in the script with `npx netlify-cli dev` |
| A page shows no fixtures | Make a season **active** (`/admin/seasons`) and add fixtures to it |

## Commands

| Command             | Action                                          |
| :------------------- | :----------------------------------------------- |
| `npm install`         | Install dependencies                             |
| `npm run dev`         | Start the local dev server at `localhost:4321`   |
| `npm run build`       | Build the production site to `./dist/`           |
| `npm run preview`     | Preview the production build locally             |
| `npm run test`        | Run unit tests (Vitest)                          |
| `npm run test:e2e`    | Run end-to-end tests (Playwright)                |
| `npm run test:all`    | Run unit + e2e tests                             |
| `npm run astro ...`   | Run Astro CLI commands, e.g. `astro check`       |

## Contributing

Contributions from club members are welcome! The workflow:

1. **Fork or branch** — if you've been added as a collaborator, create a feature branch off `main`; otherwise fork the repo.
2. **Make your change**, following the conventions in [CLAUDE.md](CLAUDE.md).
3. **Open a pull request** against `main` with a clear description of what changed and why.
4. **Wait for review** — `main` is a protected branch and every PR requires an approving review before it can be merged (see [`.github/CODEOWNERS`](.github/CODEOWNERS)). This keeps things predictable while more people pitch in.
5. Once approved, the PR will be merged in.

A few things to keep in mind:

- Never commit debug or one-off migration scripts to `netlify/functions/` — see the "Debug Scripts" section of [CLAUDE.md](CLAUDE.md) for where those belong.
- Don't commit secrets, API keys, or `.env` files.
- Keep PRs focused and reasonably small — easier to review, easier to merge.

Questions or ideas? Open an issue, or reach out at gsbengalsinc@gmail.com.

## Deploying to Netlify

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/ajthakare/goldenstatecc)
