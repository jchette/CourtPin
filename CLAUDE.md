# CLAUDE.md

This file gives Claude Code the context needed to work in this repository without re-deriving it from scratch. Read this fully before making changes.

---

## What this project is

CourtPin connects [CourtReserve](https://courtreserve.com) (court/event booking platform) with [UniFi Access](https://ui.com/door-access) (door control) to automatically grant members building access tied to their reservations and event registrations — no staff involvement required.

It is a single-file Node.js application (`index.js`) intentionally kept dependency-light and framework-free. There is no build step, no TypeScript, no database. State is a flat JSON file.

**Primary deployment target right now:** a Raspberry Pi running on the same local network as the UniFi console (no port forwarding needed — see "Deployment context" below). Railway (cloud) is the secondary/alternate deployment path, documented as an option for setups that don't want local hardware. **Caveat confirmed via the Railway dashboard directly (service showing "Online", logs actively flowing) as of 2026-08-17: this specific installation is still running on Railway, not the Pi** — the migration described below has not actually happened for it yet, despite this file describing it in the past tense. Verify current deployment target before assuming either one without checking (e.g. Railway dashboard, or whether the Pi is reachable) — this file has been wrong about it before.

---

## Architecture — one file, clearly sectioned

Everything lives in `index.js`, organized into these sections in order:

1. **Configuration** — `config` object built entirely from `process.env`. No hardcoded values anywhere.
2. **Helpers** — `loadState`, `saveState`, `findProcessedByVisitorId`, `log`, `toEpoch`, `fmtDate`, `fmtLocalDatetime`, `deriveStaticPin`, `staticPinCandidates`
3. **HTTP Clients** — `courtreserve` (axios, Basic Auth) and `unifi` (axios, Bearer token, self-signed cert bypass)
4. **Email** — `sendUnlockNotificationEmail`, `sendUnlockNotificationSms`, `sendAccessEmail`, `_sendEmail` (shared transport helper), `sendAccessSms`
5. **CourtReserve API** — `fetchTodaysReservations`, `fetchTodaysEventRegistrations`, `submitCourtReserveCheckIn`
6. **UniFi Access API** — `generatePin`, `createVisitor`, `assignPin`, `assignPinWithFallback`, `deleteVisitor`, `unlockDoor`, `fetchExpiredUnifiVisitors`
7. **Core Processing** — `processReservation`, `processEvents`, `cleanupExpiredVisitors`, `processUnlockWebhookEvent`, `runCycle`
8. **Admin Server** — `startAdminServer` (includes the public `/webhook/unifi-unlock` route) and session helpers (`generateSessionId`, `isAuthenticated`, `getSessionId`)
9. **Admin HTML** — `loginPage`, `dashboardPage` (return raw HTML strings, no templating engine)
10. **Entrypoint** — `validateConfig`, `main`

When adding a feature, find the matching section and keep new code there rather than appending to the bottom of the file.

---

## Core flow (read this before touching processing logic)

Every minute, `runCycle()`:

1. Fetches today's active **reservations** from CourtReserve → `processReservation()` per reservation, per player
2. Fetches today's active **event registrations** from CourtReserve → `processEvents()`, grouped by event session
3. Runs `cleanupExpiredVisitors()` — two passes: (a) delete visitors tracked in `state.json` past their end time, (b) query UniFi directly for any expired, CourtPin-created visitor not in state (catches orphans from state resets)

`runCycle()` is guarded by a module-level `cycleInProgress` flag — if a cycle is still running when the next `cron.schedule('* * * * *', ...)` tick fires, the new tick logs a warning and returns immediately instead of starting a second, overlapping cycle. This exists because node-cron does not wait for the previous invocation to finish; a slow/hanging request (e.g. an SMTP connection stuck until its ~2 minute timeout) could otherwise let two cycles race to process the same reservation concurrently — this was a real production bug, showing up as repeated UniFi `CODE_SYSTEM_ERROR` failures on `assignPin()`. **Don't remove this guard** without an equivalent replacement.

### Reservations
One UniFi Visitor + one PIN per player on the reservation. State key: `reservationId:memberId`.

### Events — three access modes, controlled by `EVENT_ACCESS_MODE`
- **`pin_individual`** (default) — same as reservations, one Visitor + PIN per registrant. State key: `evt:eventId:eventDateId:memberId`
- **`pin_shared`** — one Visitor + PIN for the whole event, same PIN sent to all registrants. State key: `evt:eventId:eventDateId:shared`
- **`unlock`** — unlocks door(s) in `UNIFI_RESOURCES` for the event duration, no PINs. State key: `evt:eventId:eventDateId:unlock`

**Important pattern used in both `pin_shared` and `unlock`:** visitor/door-unlock creation and per-registrant notification are deliberately split into two separate steps. Step 1 (create visitor / unlock door) only runs once per event and is gated by `!state.processed[key]`. Step 2 (notify registrants) runs **every cycle** and tracks who's been notified via a `notified: []` array stored on the same state entry, checking each registrant's `OrganizationMemberId` against it. This was a real bug fixed in production — a first version gated the whole block (including notification) behind the "already processed" check, which meant new registrants who joined after the first cycle never got notified. **Do not re-merge these steps if extending this logic.**

---

## PIN generation modes

Controlled by `PIN_MODE`:
- `random` (default) — calls UniFi's PIN generation endpoint, works regardless of PIN length constraints
- `static` — uses the CourtReserve `OrganizationMemberId` as the PIN via `deriveStaticPin()`, assigned through `assignPinWithFallback()`. Falls back to random if `memberId` is falsy (guests booking without a member ID, e.g.) — this fallback exists in both `processReservation` and `processEvents` and logs a warning only in the reservation path (the event path fails silently by design since guest bookings on events are common and not worth logging every time).

`STATIC_PIN_LENGTH` controls truncation when `PIN_MODE=static`:
- `full` (default) — uses the entire member ID regardless of length
- a number (e.g. `4`) — truncates to the last N digits via `.slice(-N)`

**PIN collision fallback:** UniFi enforces PIN uniqueness across active credentials, but only ever returns a PIN hash on reads — never plaintext — so a collision can't be checked for in advance, only discovered when `assignPin()` itself fails. With a short `STATIC_PIN_LENGTH` (e.g. `4`, a 10,000-value keyspace), two different members can derive the same truncated PIN; this became a real production incident (three collision pairs found across the membership list). `assignPinWithFallback()` (called from both `processReservation` and `processEvents`) handles this by retrying with `staticPinCandidates()` — a ladder of increasingly long digit counts from the configured base length up to the member's full ID — and if every static-length candidate still collides, falls back to a fully random, UniFi-generated PIN as the last resort. Do not revert this to a single direct `deriveStaticPin()` + `assignPin()` call — it reintroduces the collision bug.

**UniFi Fabric PIN length — not a bug, a hidden setting:** what looked initially like a confirmed Ubiquiti platform bug (PIN Length stuck at Fixed 4-digit on Fabric-enrolled sites, even though the UI showed a Variable Length option) turned out to be a setting, not a bug. Fabric's **Identity Settings** default "Smart Door Access" to **All**, which forces Fixed 4-digit PINs; switching it to **Custom** exposes the actual PIN length/type controls. `STATIC_PIN_LENGTH` remains useful even after fixing this — it's still the default/preferred PIN length for clubs that want a specific length — but it's no longer a mandatory workaround for a platform limitation.

---

## Permanent-access members (optional, `PERMANENT_ACCESS_MEMBERSHIP_KEYWORD`)

Some clubs give a membership tier (e.g. a gym add-on) a permanent 24/7 UniFi credential set up outside of CourtPin — confirmed in production at Ohio Valley Pickleball Club. Without special-casing this, `processReservation`/`processEvents` still try to issue that member a *second*, temporary Visitor + PIN for every court reservation, which collides with their existing permanent credential. `assignPinWithFallback()` handles the collision fine (see "PIN generation modes" above) but the outcome is still bad: the member gets emailed a different, temporary PIN they don't need, alongside an unnecessary extra Visitor object in UniFi that has to be cleaned up later.

`hasPermanentAccess(memberId)` (CourtReserve API section) calls `GET /api/v1/member/get?organizationMemberId=...` and matches `MembershipTypeName` case-insensitively against the configured keyword (substring match — e.g. `Gym` matches `"Pro + Gym"`), also requiring `MembershipStatus === 'Active'`. This is a separate CourtReserve API call per newly-seen player/registrant (not per cycle — gated the same way as everything else by `state.processed`), distinct from the `ReservationReport`/`EventRegistrationReport` roles already required elsewhere.

When it matches, `processReservation` and the `pin_individual` branch of `processEvents` skip `createVisitor`/`assignPinWithFallback` entirely, still send the normal access email/SMS, but with `deriveStaticPin(memberId)` reused directly as the PIN instead of generating a new one — this assumes the member's permanent UniFi credential's PIN **is** that same static derivation (true when staff set it up to match, which is the common case and why the collision happens in the first place). The state entry gets `permanentAccess: true` and no `visitorId`, so `cleanupExpiredVisitors()`'s Pass 1 naturally leaves it alone (it already skips entries with no `visitorId` — same as existing `unlock`-mode event entries).

**Requires `PIN_MODE=static`.** Meaningless under `PIN_MODE=random` since there's no predictable derivation to reuse — `validateConfig()` warns (not a hard error) if the keyword is set while `PIN_MODE` isn't `static`, and `hasPermanentAccess()` itself no-ops in that case.

**Scope:** only plain reservations and `EVENT_ACCESS_MODE=pin_individual` — not `pin_shared`/`unlock`, which use one shared credential for the whole event rather than one per registrant, so "this specific registrant already has permanent access" doesn't apply the same way.

---

## Email transport — priority logic

`_sendEmail()` picks the transport with a simple, non-configurable priority: **if `RESEND_API_KEY` has any truthy value, Resend is used — full stop, regardless of whether SMTP variables are also populated.** SMTP (via nodemailer) is only used when `RESEND_API_KEY` is empty/unset. There is no merging or fallback between the two. If a user reports "I filled in SMTP but it's still using Resend," the fix is telling them to blank out `RESEND_API_KEY`, not a code change.

Resend is recommended for cloud hosting (Railway blocks outbound SMTP ports 25/465/587 on free/hobby tiers — confirmed in production: SMTP connection attempts fail with `ETIMEDOUT` on the `CONN` command, not an auth/TLS rejection, meaning no amount of SMTP credential fixing helps on a blocked port). SMTP is recommended for local hosting (Pi, NAS) where there are no port restrictions and clubs likely already have email hosting through their domain provider.

`SMTP_DEBUG=true` logs nodemailer's full SMTP conversation (including AUTH) and richer failure fields (`code`, `responseCode`, `response`, `command`) instead of just `err.message` — opt-in and meant to be turned back off after troubleshooting, since the protocol transcript is verbose.

`EMAIL_FROM` accepts a display name — `"Club Name <noreply@domain.com>"` — passed straight through unmodified to both Resend and nodemailer, no code-side parsing needed.

**Email HTML templates use fully inlined `style="..."` attributes, not a `<style>` block with classes.** New Outlook desktop was confirmed in production to not reliably apply class-based CSS from `<head>` — it silently fell back to unstyled plain text (this is how the PIN display bug was found: the PIN rendered small and unbold instead of the intended 52px bold display, while mobile Outlook and Gmail rendered it correctly). Don't reintroduce a `<style>`-block/class approach in `sendAccessEmail()` or `sendUnlockNotificationEmail()`.

---

## Deployment context

**Local (Pi) is now the primary documented path for this specific installation.** The club hit real, unresolvable port-forwarding issues (double-NAT/double-firewall) trying to let Railway (cloud) reach the on-prem UniFi console, and migrated to a Raspberry Pi on the same LAN as UniFi. This eliminates port forwarding entirely for the CourtReserve↔UniFi communication — `UNIFI_HOST` is set to the local IP (e.g. `https://192.168.1.1:12445`) and outbound-only internet access (CourtReserve API, email, SMS) is all that's needed.

Process management on the Pi is via **PM2** (`pm2 start index.js --name courtpin`, `pm2 save`, `pm2 startup`). Updates are `git pull && pm2 restart courtpin` — there is no CI/CD on this path, unlike Railway which auto-deploys on push.

Railway remains documented as the recommended path for **other installs** that don't want on-site hardware or SSH comfort — see `docs/hosting.md` for the full comparison across all six supported hosting methods (Railway, Raspberry Pi, Docker, Synology/QNAP NAS, VPS, Windows PC).

A `Dockerfile` is intentionally **not** committed to the repo root — Railway auto-detects Node.js via Nixpacks, and a committed Dockerfile overrides that detection and causes build failures (`npm ci` requiring a lockfile that doesn't exist, since this repo doesn't commit `package-lock.json`). The Dockerfile content needed for Docker-based self-hosting is documented inline in `docs/hosting.md` for users to create themselves.

---

## CourtReserve API notes

- Auth is HTTP Basic: `CR_ORG_ID` as username, `CR_API_KEY` as password, on every request via the `courtreserve` axios instance.
- `GET /api/v1/reservationreport/listactive` — requires `ReservationReport` role with Read permission. Returns `Players[]` per reservation with `OrganizationMemberId`, `FirstName`, `LastName`, `Email`, `Phone`.
- `GET /api/v1/eventregistrationreport/listactive` — requires `EventRegistrationReport` role with Read permission (separate role from reservations, must be enabled explicitly on the API key). Returns one row per registrant with `EventId`, `EventDateId`, `EventName`, `StartTime`, `EndTime`, `OrganizationMemberId`, `FirstName`, `LastName`, `Email`, `Phone`.
- Both endpoints are queried for **today's date range only** (`startOfDay` to `endOfDay` in local time), not a rolling window. This is intentional — `StartTime`/`EndTime` come back with no timezone suffix, so the query and all time math assumes the `TZ` env var matches the facility's actual timezone. Getting `TZ` wrong is the most common real-world bug reported (see `docs/troubleshooting.md`).
- Date range parameters cannot exceed 31 days per CourtReserve's API constraints (documented behavior, not a CourtPin limitation).
- `POST /api/v1/checkins` — requires the `Check-In` role with Write permission (used by the optional Auto Check-In feature). Not guaranteed to be an assignable role for every organization — see the "Auto Check-In" section below. Conditionally requires `CheckInStatusId` in the request body depending on org config — see the same section.

## UniFi Access API notes

- Auth is Bearer token via the `unifi` axios instance, with `rejectUnauthorized: false` in the httpsAgent — UniFi's console uses a self-signed cert by default, this is expected and documented by Ubiquiti, not a security oversight to "fix."
- Required token scopes: `view:credential` (PIN generation), `edit:visitor` (create/update/delete visitors).
- `unlockDoor()` handles both `door` and `door_group` resource types from `UNIFI_RESOURCES` — for a `door_group` it first fetches the group's topology to enumerate individual door IDs, then unlocks each one separately (there's no single "unlock this whole group" endpoint). Door-group topology responses are not a consistent shape across consoles/firmware — some return a flat `doors[]` array, others (confirmed in production) nest doors arbitrarily deep under `resource_topologies[]` (e.g. `building → floor → resources[]`, `type: "door"`). `collectDoorsFromTopology()` walks both shapes recursively; don't go back to a flat `group.doors || []` read, it silently finds zero doors on nested-shape consoles.
- Once a PIN is assigned, UniFi's API only returns a hash on future reads — the plaintext PIN is unrecoverable from UniFi's side. This is why CourtPin persists the PIN in `state.json` and logs at creation time — it's the only source of truth for the admin portal's PIN lookup/resend feature. This also means a PIN collision can only ever be discovered by attempting `assignPin()` and having it fail — there's no way to check "is this PIN already active" in advance (see `assignPinWithFallback()` in the PIN generation modes section above).
- Every visitor `createVisitor()` creates is tagged via the `remarks` field with a fixed marker (`CREATED_BY_MARKER = 'Created by CourtPin'`). `fetchExpiredUnifiVisitors()` — the orphan-recovery pass in `cleanupExpiredVisitors()` — filters on this tag so it only ever deletes visitors CourtPin itself created, never visitors added manually by staff or by another integration. `remarks` was confirmed as a genuine free-text field (distinct from the enum-constrained `visit_reason`, which only accepts `Interview`/`Business`/`Cooperation`/`Others`) against Ubiquiti's official Visitor API schema (PDF, p. 52–53) before relying on it. Visitors created before this tagging existed won't carry the marker — a one-time manual cleanup in the UniFi console is needed for any pre-existing orphans, but that's a non-issue if state.json was empty when this shipped.

---

## Auto Check-In (optional, `AUTO_CHECKIN_ENABLED`)

A UniFi Access PIN-code door unlock can automatically submit a CourtReserve check-in for that member — no separate kiosk touch needed. Full user-facing setup is `docs/auto-checkin.md`; the CourtReserve OpenAPI spec (trimmed to relevant endpoints) is saved at `docs/courtreserve-openapi-organization.json`. Design/research history — including an earlier, abandoned kiosk-session-replication approach — is in `docs/pin-checkin-integration-notes.md`.

**Flow:** UniFi's Alarm Manager POSTs to the public `/webhook/unifi-unlock?secret=...` route (Admin Server section, placed **before** the `isAuthenticated` gate — it can't use session auth since UniFi is the caller) → `processUnlockWebhookEvent()` filters to `credential_type === 'PIN_CODE'` and `direction === 'entered'` only, reverse-looks-up the event's `user` UUID against `state.processed` via `findProcessedByVisitorId()` (confirmed in production: this UUID is an exact match for the `visitorId` CourtPin already stores) → calls `submitCourtReserveCheckIn(reservationId, memberId)`, which POSTs to CourtReserve's official `POST /api/v1/checkins` using the existing Basic Auth `courtreserve` client (no separate HTTP client, no cookie jar, no kiosk registration needed).

**Scope: plain court reservations and `EVENT_ACCESS_MODE=pin_individual` event registrations.** `reservationId` is stored on reservation state entries (`processReservation`) and on `pin_individual` event state entries (`processEvents`, via `fetchEventReservationId()`) to support this. `pin_shared`/`unlock` event entries deliberately never carry a `reservationId` and are not supported — those modes use one shared visitor/credential for the whole event, so the webhook's visitor UUID can't identify which specific registrant unlocked the door. `processUnlockWebhookEvent()` matches all event-derived entries but only actually checks in ones with a `reservationId`; everything else is skipped (`unsupported_entry_type`) rather than guessing.

Since `EventRegistrationReport` doesn't expose a `ReservationId` (only `EventId`/`EventDateId`), `fetchEventReservationId()` resolves it via a separate call to `/api/v1/eventcalendar/eventlist`, matching client-side on `EventId` + the session's start/end time (confirmed in production: `eventlist`'s `eventFilterId` query param does **not** filter by `EventId` despite the name — it returned zero rows for an `EventId` present in the same unfiltered date range — so don't rely on it). This runs once per event session per cycle, only when there's a newly-seen registrant to process (same gating pattern as `hasPermanentAccess()`). If it fails or finds no match, the registrant still gets their PIN as normal, they're just not eligible for auto check-in that session. `status=All` is used deliberately so an already auto-cancelled session (e.g. a club's low-participation auto-cancel policy that frees the court) still resolves a `ReservationId` — the actual `POST /api/v1/checkins` call against it just fails cleanly later (`checkin_failed`), same as any other ended/cancelled reservation.

**Idempotency:** a successful check-in stamps `checkedInAt` on the matched state entry; repeat/duplicate webhook deliveries for the same entry are skipped (`already_checked_in`) rather than re-submitting. Don't remove this guard — CourtReserve's own API doesn't appear to no-op a duplicate check-in on its own.

**Auth for the webhook route is a shared secret in the URL query string (`CHECKIN_WEBHOOK_SECRET`), not HMAC signing.** UniFi's Alarm Manager UI only exposes a plain Delivery URL field — there's no signing option to use instead, so this is the only mechanism available. Treat it as a low-value shared secret (visible in UniFi's config UI and plain HTTP logs), not a real credential.

**`CheckInStatusId` may be required — this is org-specific, not universal.** Confirmed in production: an org with CourtReserve's "Check-In Statuses" feature enabled (Settings → Check-In Statuses) rejects `/api/v1/checkins` calls without a `CheckInStatusId` (`"CheckInStatusId is required because this organization uses check-in statuses."`). The admin UI for that settings page shows status names only, not IDs — the numeric ID has to be pulled from the underlying `GET /CheckInStatus/GetCheckInStatuses` call (not a public API endpoint, just what the CourtReserve admin frontend itself calls) while logged into CourtReserve admin. `CHECKIN_STATUS_ID` is optional in `config.checkin` — only included in the request payload when set — since orgs without this feature don't need it.

**The `Check-In` API role is not guaranteed to be assignable on a scoped CourtReserve API key.** Confirmed in production: one org's API-key role list (Settings → API Access) simply doesn't include `Check-In` as an option, even though it's a documented role in CourtReserve's OpenAPI spec. A scoped key without it gets a flat `{"Message":"Authorization has been denied for this request."}` — a framework-level rejection before check-in logic even runs, distinct from the normal `GenericEnterpriseApiResponse` envelope (`ErrorMessage`/`Data`/`IsSuccessStatusCode`) every other endpoint in this codebase returns on failure. If this happens, the fix is contacting CourtReserve support to enable the role for that organization — not silently switching every install to an unrestricted/full-access token. **This specific installation is currently running with a full-access token in `CR_API_KEY` as an interim measure** while that support request is pending; this is a deliberate, known tradeoff (wider blast radius if the key leaks) accepted by the project owner, not an oversight — don't "fix" it by reverting without checking whether the scoped-role fix has landed.

---

## State file (`state.json`)

Flat JSON, single top-level key `processed`, keyed by the state keys described above. No database, no migrations. On Railway this lives at `/tmp/state.json` (or wherever `STATE_FILE` points) by default — ephemeral, cleared on **every** redeploy, including ones triggered just by changing an environment variable, not only code pushes. This is why the UniFi-side orphan cleanup pass in `cleanupExpiredVisitors()` exists as a safety net — it's scoped to CourtPin-created visitors only via the `remarks` tag (see "UniFi Access API notes" above), so it's safe to run even when other visitors exist in UniFi. The practical impact of a state wipe is reprocessing (duplicate PIN emails) for anything still inside its notification window — see `docs/hosting.md` Option 1 Step 7 for attaching a Railway Volume so `STATE_FILE` survives redeploys. On the Pi it can live anywhere persistent, e.g. `~/courtpin/state.json`, with no such issue.

If you need to force CourtPin to reprocess something (e.g. for testing), the state file can be edited directly or the `STATE_FILE` path changed to point somewhere fresh — there's no CLI or admin-portal action to do this currently.

---

## Admin portal

Plain Node `http` server (no Express), started by `startAdminServer()`. Session auth is a random hex token stored in an in-memory `Set` (`sessions`) — sessions are lost on process restart by design (acceptable for a low-traffic internal admin tool). Cookie name: `courtpin_session`.

Routes:
- `GET /admin/login`, `POST /admin/login` — password check against `ADMIN_SECRET`
- `GET /admin/logout`
- `GET /admin` — dashboard, requires auth
- `POST /admin/resend` — re-sends PIN email/SMS for a given `reservationId`/`playerId` pair, requires auth
- `GET /health` — no auth, basic liveness check
- `POST /webhook/unifi-unlock` — no session auth (shared-secret `?secret=` query param instead); accepts UniFi Access Alarm Manager webhook deliveries for the optional Auto Check-In feature (see that section above). Returns 404 when `AUTO_CHECKIN_ENABLED` is false.

Dashboard cards show a yellow badge (`Event`, `Event (shared PIN)`, or `Event (door unlock)`) to visually distinguish event-derived access from reservation-derived access — see the `isEvent`/`typeLabel` logic in `dashboardPage()`.

---

## Things NOT to do without asking first

- **Don't rewrite large chunks of `index.js` speculatively.** This project has an explicit house rule (set by the project owner mid-session) that code changes only happen on explicit request — questions about "is X possible" are not requests to implement X. When in doubt, ask before editing.
- **Don't re-add a root-level `Dockerfile`** without confirming Railway deployment isn't the active target — it breaks Nixpacks auto-detection there (see "Deployment context" above).
- **Don't merge the two-step pattern** in `pin_shared`/`unlock` event processing back into a single gated block — this reintroduces the late-registrant notification bug described above.
- **Don't add STOP/opt-out language to SMS.** It was deliberately removed — see git history around the SMS template rewrite — because these are transactional access messages, not marketing, and STOP replies would unsubscribe someone from future PIN delivery in a way that causes real confusion at the door.
- **Don't assume `.env` exists in the repo.** It's gitignored. `env.example` is the template; real credentials live only in Railway's Variables tab or a local `.env` on the Pi.
- **Don't remove the `cycleInProgress` overlap guard in `runCycle()`.** A hanging request (e.g. SMTP) can otherwise let two cron ticks process the same reservation concurrently — this caused a real production incident (repeated UniFi `CODE_SYSTEM_ERROR`).
- **Don't revert the email templates' inlined `style="..."` attributes back to a `<style>` block with classes.** New Outlook desktop doesn't reliably apply class-based CSS and silently renders unstyled text — confirmed in production on the PIN display.
- **Don't revert `assignPinWithFallback()`/`staticPinCandidates()` back to a single direct `deriveStaticPin()` + `assignPin()` call.** Two members can derive the same truncated static PIN (confirmed in production — three collision pairs found), and UniFi enforces PIN uniqueness across active credentials without any way to check in advance.
- **Don't remove the `remarks: CREATED_BY_MARKER` tag from `createVisitor()` or the `v.remarks === CREATED_BY_MARKER` filter in `fetchExpiredUnifiVisitors()`.** Without it, the orphan-recovery pass in `cleanupExpiredVisitors()` would delete *any* expired visitor in UniFi — including ones created manually by staff or by another integration, not just CourtPin's own.
- **Don't remove the `checkedInAt` idempotency guard in `processUnlockWebhookEvent()`.**
- **Don't wire up auto check-in for `pin_shared`/`unlock` event entries.** Unlike `pin_individual`, those modes share one visitor/credential across every registrant, so the webhook's visitor UUID can't identify which specific registrant unlocked the door — see the "Auto Check-In" section above.
- **Don't assume `CR_API_KEY` is a narrowly-scoped key.** This installation currently runs it as a full-access/unrestricted token as a deliberate interim measure (the `Check-In` role wasn't assignable on a scoped key for this org) — see "Auto Check-In" above. Don't add code that relies on this being scoped, and flag it if you notice it should have been narrowed back down by the time you're reading this.

---

## Versioning and release notes

Releases are tagged on GitHub (`github.com/jchette/courtpin/releases`) following semver:
- Patch (`v1.0.x`) — bug fixes
- Minor (`v1.x.0`) — new backward-compatible features (e.g. `v1.1.0` added `PIN_MODE`)
- Major (`vx.0.0`) — significant feature additions (e.g. `v2.0.0` added event support)

**House rule:** only tag a release after the change has been confirmed working in production by the project owner — not immediately after writing the code. If uncertain whether something's been tested, ask before proposing a version bump. Release notes use GitHub-flavored markdown with a consistent structure: `## What's new/changed`, code blocks for env vars, `## Files changed`, `## How to update`, `## Verified`.

---

## Documentation map

- `README.md` — lean entry point, links out to `docs/`
- `docs/configuration.md` — every env var, plus a copy-paste Railway raw-editor block
- `docs/hosting.md` — all six hosting methods (Railway, Pi, Docker, NAS, VPS, Windows)
- `docs/unifi-setup.md` — API token creation, door group IDs, port forwarding, Cloudflare Tunnel
- `docs/email-setup.md` — Resend setup, SMTP setup (including provider-specific settings and Gmail app passwords), local SMTP servers
- `docs/admin-portal.md` — using the PIN lookup/resend portal
- `docs/auto-checkin.md` — optional PIN-unlock → CourtReserve check-in feature: setup, `CheckInStatusId`/`Check-In` role gotchas, known limitations
- `docs/courtreserve-openapi-organization.json` — trimmed CourtReserve OpenAPI reference (Check-In, Reservation Report, Event Registration Report, Event Calendar, Attendance Report)
- `docs/troubleshooting.md` — symptom → cause → fix, including the UniFi Fabric PIN-length setting

Keep these in sync when changing behavior — this project has been burned before by docs drifting out of date after a code change (see the SMS STOP-line and PIN_MODE doc-sync fixes in project history). When you change a env var's behavior or add a new one, update `env.example`, `docs/configuration.md`, and the README feature list in the same pass.
