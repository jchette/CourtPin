# Contributing to CourtPass

Thank you for your interest in CourtPass. Contributions of all kinds are welcome — bug fixes, new features, documentation improvements, and real-world feedback from clubs using it in production.

---

## Table of Contents

1. [Ways to contribute](#ways-to-contribute)
2. [Development setup](#development-setup)
3. [Project structure](#project-structure)
4. [Code style guidelines](#code-style-guidelines)
5. [Submitting a pull request](#submitting-a-pull-request)
6. [Reporting a bug](#reporting-a-bug)
7. [Suggesting a feature](#suggesting-a-feature)
8. [Ideas for future contributions](#ideas-for-future-contributions)
9. [Questions](#questions)

---

## Ways to contribute

### Report a bug

If something is not working, open a GitHub Issue and include:

- A clear description of what you expected to happen
- A clear description of what actually happened
- Relevant log output from Railway (paste the relevant lines)
- Your UniFi Access firmware version
- Your CourtReserve plan type
- Which environment variables you have set (redact the actual values)

The more detail you provide, the faster it can be diagnosed.

### Suggest a feature

Open a GitHub Issue with the label `enhancement`. Describe the use case — real stories from club operators are especially helpful. Explain what problem you are trying to solve, not just what you want built.

### Improve documentation

The README is intentionally thorough but there is always room for improvement. If a section is unclear, a step is missing, or something confused you during setup, a documentation pull request is very welcome.

### Submit a code fix or feature

See the Submitting a pull request section below.

---

## Development setup

To work on CourtPass locally you need Node.js 18 or later installed. You will also need real credentials for CourtReserve and UniFi Access to test against — CourtPass does not have a mock mode.

```bash
# 1. Fork the repository on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/courtpass.git
cd courtpass

# 2. Install dependencies
npm install

# 3. Create your local configuration file
cp env.example .env

# 4. Fill in your actual credentials in .env
# At minimum you need:
#   CR_ORG_ID, CR_API_KEY
#   UNIFI_HOST, UNIFI_API_TOKEN
#   RESEND_API_KEY, EMAIL_FROM
#   ADMIN_SECRET
#   TZ

# 5. Start the development server with auto-reload
npm run dev

# Or start without auto-reload
npm start
```

### Watching the logs

CourtPass logs every action to stdout with a timestamp and level:

```
[2026-03-15T12:00:00.000Z] [INFO]  Fetched 2 reservation(s)
[2026-03-15T12:01:00.000Z] [DEBUG] Reservation timing check {"reservationId":"50786225",...}
[2026-03-15T12:01:00.000Z] [INFO]  Processing player {"memberId":1788252,...}
[2026-03-15T12:01:02.000Z] [INFO]  ✅ Player processed successfully {"pin":"67203419",...}
```

Log levels are `debug`, `info`, `warn`, and `error`.

### Testing a specific scenario

To test without waiting for a real reservation to fall into the 60-minute window, temporarily set:

```
NOTIFY_MINUTES_BEFORE=1440
```

This makes CourtPass process any reservation happening today, regardless of how far away it is.

---

## Project structure

CourtPass is intentionally a single-file project to keep it easy to read and understand.

```
courtpass/
├── index.js            The entire application — all configuration, API calls,
│                       email/SMS functions, admin server, and scheduler
├── package.json        Project metadata and dependencies
├── env.example         Template showing every available environment variable
├── Dockerfile          Builds the Docker image for container-based hosting
├── docker-compose.yml  Defines the Docker service, volume, and port mapping
├── .dockerignore       Excludes unnecessary files from the Docker image
├── .gitignore          Prevents credentials and state files from being committed
├── README.md           Full documentation
├── CONTRIBUTING.md     This file
└── LICENSE             MIT license
```

### Sections inside index.js

The file is organized into clearly labeled sections separated by comment banners:

| Section | What it contains |
|---|---|
| Configuration | `config` object built from environment variables |
| Helpers | Utility functions: `loadState`, `saveState`, `log`, `toEpoch`, `fmtDate`, `fmtLocalDatetime` |
| HTTP Clients | axios instances for CourtReserve and UniFi with their auth configured |
| Email | `sendAccessEmail` function — builds and sends the HTML email via Resend |
| SMS | `sendAccessSms` function — builds and sends the text message via Twilio |
| CourtReserve API | `fetchTodaysReservations` — queries today's active reservations |
| UniFi Access API | `generatePin`, `createVisitor`, `assignPin`, `deleteVisitor` |
| Core Processing | `processReservation`, `cleanupExpiredVisitors`, `runCycle` — the main loop logic |
| Admin Server | `startAdminServer` — the HTTP server for the admin portal |
| Admin HTML | `loginPage`, `dashboardPage` — returns HTML strings for the admin UI |
| Entrypoint | `validateConfig`, `main` — startup and scheduler initialization |

---

## Code style guidelines

CourtPass deliberately avoids build tools, transpilers, and heavy frameworks to stay accessible to developers of all experience levels.

- **Plain Node.js** — no TypeScript, no Babel, no webpack
- **Minimal dependencies** — currently only `axios`, `dotenv`, and `node-cron`. Think carefully before adding a new dependency.
- **Configuration via environment variables** — no hardcoded values anywhere in the code
- **Single responsibility** — each function does one thing and has a name that says what it does
- **Inline comments only where necessary** — the code should be readable without them in most places
- **Consistent error handling** — all API calls are wrapped in try/catch and log errors with context
- **`'use strict'` at the top** — enforced throughout

For formatting, match the style of the surrounding code. The project does not use a linter or formatter currently.

---

## Submitting a pull request

1. **Fork** the repository on GitHub
2. **Create a branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/description-of-bug
   ```
3. **Make your changes** — keep commits focused and descriptive
4. **Test your changes** against a real CourtReserve and UniFi Access setup if at all possible
5. **Run a syntax check:**
   ```bash
   node --check index.js
   ```
6. **Push your branch** and open a pull request on GitHub
7. In the pull request description explain:
   - What problem this solves or what it adds
   - How you tested it
   - Any configuration changes required (new environment variables, etc.)

Pull requests are reviewed on a best-effort basis. Small, focused changes are much easier to review and merge than large ones.

---

## Reporting a bug

Before opening a bug report, check the Troubleshooting section of README.md — your issue may already be documented there.

When opening a GitHub Issue for a bug, please include:

```
### What I expected to happen


### What actually happened


### Relevant log lines from Railway
(paste them here — redact any credentials)

### Environment
- UniFi Access version:
- CourtReserve plan:
- NOTIFY_MINUTES_BEFORE:
- ACCESS_BUFFER_MINUTES:
- TZ:
- TWILIO_ENABLED:
- Node.js version (if running locally):
```

---

## Suggesting a feature

Open a GitHub Issue with the label `enhancement` and describe:

1. **The problem you are trying to solve** — what happens today that is inconvenient or missing?
2. **Your proposed solution** — how would you like CourtPass to handle it?
3. **Alternatives you have considered** — are there workarounds you are using today?
4. **Who else this would help** — is this specific to your setup or would other clubs benefit?

---

## Ideas for future contributions

These are improvements that would genuinely help clubs using CourtPass. If you are looking for something to work on, start here.

| Idea | Description |
|---|---|
| Webhook support | Trigger on CourtReserve reservation creation instead of polling every minute. CourtReserve may support outbound webhooks — investigate and implement to reduce latency. |
| Cancellation handling | Watch for cancelled reservations and immediately revoke the PIN and delete the Visitor in UniFi when a booking is cancelled. Currently cancelled reservations are cleaned up passively after the end time. |
| Multi-door-group logic | Allow different door groups to be granted based on court type or reservation type. For example indoor courts get one door group and outdoor courts get another. |
| Persistent state storage | Replace the JSON file state store with a small embedded database (SQLite) or a free hosted database (PlanetScale, Turso) so state survives container restarts reliably. |
| Email template customization | Allow clubs to provide their own HTML email template as an environment variable or file, for full branding control beyond colors and text. |
| Docker Compose support | Add a `docker-compose.yml` for clubs who want to self-host on a local machine or NAS. |
| Setup wizard | A web-based first-run configuration page that walks through all required variables with explanations and validation, replacing the manual env file editing process. |
| Support for other access systems | Add support for other door access platforms — Brivo, Salto, Kisi, Openpath, etc. The CourtReserve side is already generic. |
| Support for other booking platforms | Abstract the reservation source so other platforms beyond CourtReserve can be used — CourtSide, Court Reserve Pro, etc. |
| Rate limiting on admin portal | Add basic rate limiting to the admin login endpoint to prevent brute-force password attempts. |
| Scheduled daily summary | Send an email to club admins each morning listing all reservations for the day and their assigned PINs. |

---

## Questions

Open a GitHub Issue with the label `question`. There are no stupid questions — if something in the documentation or code is unclear, that is itself a contribution opportunity.
