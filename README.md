# Golden State Cricket Club (GSCC)

The public website and team management system for the **Golden State Cricket Club**, run by Bengals Inc., a 501(c)(3) non-profit cricket club in the Bay Area, California.

The site covers two audiences:

- **Public pages** — club info, fixtures, photo gallery, non-profit/donation info, and a contact form.
- **Admin panel** (`/admin`) — season, fixture, player, roster, and availability management, plus statistics and audit logs, for club admins.

## Tech Stack

- [Astro.js](https://astro.build/) v5 (static site + SSR)
- [Tailwind CSS](https://tailwindcss.com/) v4
- [React](https://react.dev/) v19 for interactive components
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

| Prerequisites                                                                |
| :---------------------------------------------------------------------------- |
| [Node.js](https://nodejs.org/) v18.20.8+                                     |
| (optional) [nvm](https://github.com/nvm-sh/nvm) for Node version management. |

1. Clone the repository, then run `npm install` in its root directory.
2. Recommended: link your local repository to the Netlify project so you're using the same runtime locally as in production:
   ```bash
   netlify link
   ```
3. Run the dev server:
   ```bash
   npm run dev
   ```
   The site runs at `localhost:4321`.

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
