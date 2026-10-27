# Configuration Reference

Every aspect of CourtPin is controlled by environment variables. No code changes are needed to customize it for your club.

When running locally, copy `env.example` to `.env` and fill in your values. When running on Railway, paste the variables into the **Variables → Raw Editor** tab.

---

## Quick copy block for Railway

Paste this into Railway → Variables → Raw Editor and fill in every value:

```
CR_BASE_URL=https://api.courtreserve.com
CR_ORG_ID=your_api_key_username_here
CR_API_KEY=your_api_key_here
UNIFI_HOST=https://YOUR_PUBLIC_IP_OR_HOSTNAME:12445
UNIFI_API_TOKEN=your_unifi_api_token_here
UNIFI_RESOURCES=
# Email — choose ONE transport (see Email section below):
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
# SMTP_HOST=mail.yourclub.com
# SMTP_PORT=587
# SMTP_SECURE=false
# SMTP_USER=noreply@yourclub.com
# SMTP_PASS=your_smtp_password_here
EMAIL_FROM=noreply@yourclub.com
TWILIO_ENABLED=false
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_FROM_NUMBER=+15550000000
BRAND_CLUB_NAME=Your Club Name
BRAND_TAGLINE=Court Access System
BRAND_HEADER_COLOR=1a56db
BRAND_ACCENT_COLOR=1a56db
BRAND_WEBSITE=https://yourclub.com
BRAND_PHONE=555-555-0100
BRAND_ADDRESS=123 Main St, Your City ST
ADMIN_PORT=3000
PORT=3000
ADMIN_SECRET=choose_a_strong_password_here
EVENT_ACCESS_MODE=pin_individual
EVENT_ACCESS_BUFFER_MINUTES=30
EVENT_UNLOCK_NOTIFY=false
PIN_MODE=random
STATIC_PIN_LENGTH=full
NOTIFY_MINUTES_BEFORE=60
ACCESS_BUFFER_MINUTES=30
CLEANUP_BUFFER_MINUTES=15
TZ=America/New_York
STATE_FILE=/tmp/state.json
AUTO_CHECKIN_ENABLED=false
CHECKIN_WEBHOOK_SECRET=
CHECKIN_STATUS_ID=
PERMANENT_ACCESS_MEMBERSHIP_KEYWORD=
```

> **Note on hex colors:** Railway treats `#` as a comment character. Enter hex colors **without** the `#` symbol. For `#1a56db` enter `1a56db`. The code adds it automatically.

---

## CourtReserve

CourtReserve uses **HTTP Basic Authentication** — `CR_ORG_ID` is sent as the username and `CR_API_KEY` as the password on every request.

| Variable | Required | Default | Description |
|---|---|---|---|
| `CR_BASE_URL` | No | `https://api.courtreserve.com` | CourtReserve API base URL. Only change if given a custom URL by CourtReserve support. |
| `CR_ORG_ID` | Yes | — | The **username** CourtReserve shows for your API key (Admin → Settings → API Access). Despite the variable name, this is not necessarily your organisation ID — a deleted and reissued key gets a new username, and leaving the old value here makes every request fail with `401`. |
| `CR_API_KEY` | Yes | — | Your API key. CourtReserve Admin → Settings → API Access. See the required roles below. |

**Required API key roles** — scope the key to exactly these rather than using a full-access key:

| Role | Permission | Used for |
|---|---|---|
| `ReservationReport` | Read | Today's court reservations; admin portal PIN lookup |
| `EventRegistrationReport` | Read | Today's event registrations (including guests) |
| `EventCalendar` | Read | Resolving an event session's reservation ID for auto check-in (`pin_individual` only) |
| `Member` | Read | Permanent-access membership check (`PERMANENT_ACCESS_MEMBERSHIP_KEYWORD` only) |
| `Check-In` | Write | Auto check-in (`AUTO_CHECKIN_ENABLED` only) |

---

## UniFi Access

| Variable | Required | Default | Description |
|---|---|---|---|
| `UNIFI_HOST` | Yes | — | Full HTTPS URL of your UniFi console including port 12445. Examples: `https://192.168.1.1:12445` (local), `https://yourclub.duckdns.org:12445` (remote). |
| `UNIFI_API_TOKEN` | Yes | — | API token from UniFi Portal → Access → Settings → General → Advanced. Requires `view:credential` and `edit:visitor` scopes. |
| `UNIFI_RESOURCES` | Recommended | — | Doors/groups members can access. Format: `door_group:ID` or `door:ID`. Comma-separate multiple entries. Leave empty to test without granting door access. |

**Finding door group IDs:** See [unifi-setup.md](unifi-setup.md).

---

## Email

CourtPin supports two email transport modes. Set **one or the other** — not both. If `RESEND_API_KEY` is present it takes priority. If blank or absent, SMTP is used.

At startup CourtPin logs which transport is active:
```
[INFO] Email transport: Resend
```
or
```
[INFO] Email transport: SMTP {"host":"mail.yourclub.com","port":587}
```

### Option A — Resend (recommended for Railway / cloud hosting)

Resend sends email over HTTPS (port 443) which is never blocked on cloud platforms. SMTP ports are blocked on Railway's free and hobby tiers.

| Variable | Required | Default | Description |
|---|---|---|---|
| `RESEND_API_KEY` | If using Resend | — | API key from resend.com → API Keys. Leave blank to use SMTP instead. |
| `EMAIL_FROM` | Yes | — | Sender address. Must be from a domain verified in Resend. Use `onboarding@resend.dev` for testing. Optionally include a display name: `Your Club Name <noreply@yourclub.com>`. |

### Option B — SMTP (recommended for local / self-hosted)

On a local machine there are no port restrictions — use your existing email host or a local SMTP server.

| Variable | Required | Default | Description |
|---|---|---|---|
| `SMTP_HOST` | If using SMTP | — | SMTP server hostname. Example: `mail.yourclub.com` |
| `SMTP_PORT` | If using SMTP | `587` | SMTP port. Use `587` for STARTTLS or `465` for implicit TLS. |
| `SMTP_SECURE` | No | `false` | Set `true` only for port 465. Leave `false` for port 587. |
| `SMTP_USER` | If using SMTP | — | SMTP username — usually your full email address. |
| `SMTP_PASS` | If using SMTP | — | SMTP password or app password. |
| `SMTP_DEBUG` | No | `false` | Set `true` to log the full SMTP conversation (including AUTH) for troubleshooting delivery failures. Turn back off afterward — verbose and not needed in normal operation. |
| `EMAIL_FROM` | Yes | — | Sender address — must match your SMTP account domain. Optionally include a display name: `Your Club Name <noreply@yourclub.com>`. |

**Common SMTP settings by provider:**

| Provider | `SMTP_HOST` | `SMTP_PORT` | `SMTP_SECURE` |
|---|---|---|---|
| Bluehost / cPanel | `mail.yourdomain.com` | `465` | `true` |
| Gmail | `smtp.gmail.com` | `587` | `false` |
| Google Workspace | `smtp.gmail.com` | `587` | `false` |
| Microsoft 365 | `smtp.office365.com` | `587` | `false` |
| Mailhog (local test) | `localhost` | `1025` | `false` |

> **Gmail/Google Workspace:** Your regular password will not work — create an App Password at myaccount.google.com → Security → 2-Step Verification → App passwords.

---

## SMS — Twilio (optional)

SMS is sent in addition to email when enabled. Member phone numbers come directly from CourtReserve reservation data.

| Variable | Required | Default | Description |
|---|---|---|---|
| `TWILIO_ENABLED` | No | `false` | Set `true` to activate SMS. All three variables below must also be set. |
| `TWILIO_ACCOUNT_SID` | If SMS enabled | — | Account SID from twilio.com/console. Starts with `AC`. |
| `TWILIO_AUTH_TOKEN` | If SMS enabled | — | Auth token from twilio.com/console. |
| `TWILIO_FROM_NUMBER` | If SMS enabled | — | Your Twilio phone number in E.164 format. Example: `+13045550100`. |

---

## Branding

All emails and the admin portal use these values. No code changes needed.

| Variable | Required | Default | Description |
|---|---|---|---|
| `BRAND_CLUB_NAME` | No | `Our Club` | Club name shown in email header, subject line, SMS, and admin portal. |
| `BRAND_TAGLINE` | No | — | Optional subtitle under the club name in emails. |
| `BRAND_HEADER_COLOR` | No | `1a56db` | Email header background color — hex code **without** `#`. |
| `BRAND_ACCENT_COLOR` | No | `1a56db` | PIN box and button color — hex code **without** `#`. |
| `BRAND_WEBSITE` | No | — | Club website URL. Shown in email footer. |
| `BRAND_PHONE` | No | — | Club phone number. Shown in email footer. |
| `BRAND_ADDRESS` | No | — | Club address. Shown in email footer. |

Find hex color codes at [htmlcolorcodes.com](https://htmlcolorcodes.com).

---

## Admin Portal

| Variable | Required | Default | Description |
|---|---|---|---|
| `ADMIN_PORT` | No | `3000` | Port the admin web server listens on. Match this with `PORT`. |
| `PORT` | No | `3000` | Required by Railway to expose a public URL. Set to the same value as `ADMIN_PORT`. |
| `ADMIN_SECRET` | Yes | — | Password to log into the admin portal. Protects access to all active member PINs — choose something strong. |

---

## Behaviour

| Variable | Required | Default | Description |
|---|---|---|---|
| `EVENT_ACCESS_MODE` | No | `pin_individual` | How door access is granted to event registrants. `pin_individual` — each registrant gets their own unique PIN. `pin_shared` — one PIN for the whole event sent to all registrants. `unlock` — door(s) unlocked for the event duration, no PINs. |
| `EVENT_ACCESS_BUFFER_MINUTES` | No | `30` | How many minutes before the event start that access activates. Independent of `ACCESS_BUFFER_MINUTES` for reservations. |
| `EVENT_UNLOCK_NOTIFY` | No | `false` | Unlock mode only. Set `true` to send an email and optional SMS to all registrants notifying them the facility will be open. |
| `PIN_MODE` | No | `random` | How PINs are generated. `random` creates a new PIN each reservation. `static` uses the member's CourtReserve `OrganizationMemberId` as their PIN — members learn it once and reuse it forever. Static mode requires UniFi Access PIN mode set to **Variable Length** (Access → Settings → General → PIN). |
| `STATIC_PIN_LENGTH` | No | `full` | Only applies when `PIN_MODE=static`. `full` uses the entire `OrganizationMemberId` as the PIN. A number (e.g. `4`, `6`, `8`) truncates to the last N digits — set this to match a fixed PIN length configured on the UniFi side (e.g. Fabric sites — see `docs/troubleshooting.md`). Applies universally to both reservations and events since it reflects the UniFi installation's configuration, not any individual booking. If a truncated PIN collides with another member's active PIN, CourtPin automatically retries with more digits, then falls back to a random PIN — see `docs/troubleshooting.md`. |
| `NOTIFY_MINUTES_BEFORE` | No | `60` | How many minutes before a reservation to send the PIN. |
| `ACCESS_BUFFER_MINUTES` | No | `30` | How many minutes before the reservation the PIN becomes active. Members can enter the building this early. |
| `CLEANUP_BUFFER_MINUTES` | No | `15` | Minutes after reservation end before the Visitor record is deleted and PIN revoked. |
| `TZ` | Yes on Railway | — | Your facility's timezone. **Critical on Railway** which runs in UTC. Examples: `America/New_York`, `America/Chicago`, `America/Denver`, `America/Los_Angeles`. Full list: [Wikipedia — tz database](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones). |
| `STATE_FILE` | No | `./state.json` | Path to the state persistence file. Use `/tmp/state.json` on Railway. |

---

## Auto Check-In (optional)

When enabled, entering a PIN at the door also submits a CourtReserve check-in for that member automatically — no separate kiosk touch needed. Reuses `CR_ORG_ID`/`CR_API_KEY` above; no new CourtReserve credentials required, but the API key needs the **Check-In** role (Write permission) enabled. Scope is plain court reservations and `EVENT_ACCESS_MODE=pin_individual` event registrations (not `pin_shared`/`unlock`, and not guest/public-booking registrants). Full setup (including the UniFi Alarm Manager webhook configuration) is in [auto-checkin.md](auto-checkin.md).

| Variable | Required | Default | Description |
|---|---|---|---|
| `AUTO_CHECKIN_ENABLED` | No | `false` | Set `true` to enable the `/webhook/unifi-unlock` endpoint. When `false`, the endpoint returns a plain 404. |
| `CHECKIN_WEBHOOK_SECRET` | If enabled | — | Shared secret checked against the webhook URL's `?secret=` query param. UniFi's Alarm Manager has no HMAC signing, so this is the only available auth mechanism. Generate a long random string. |
| `CHECKIN_STATUS_ID` | If your org uses custom Check-In Statuses | — | Some CourtReserve orgs have Settings → Check-In Statuses enabled, in which case the API rejects a check-in without a status ID. Find yours via `https://app.courtreserve.com/CheckInStatus/GetCheckInStatuses` while logged into CourtReserve admin — use the `Id` for "Checked-In" (or your org's equivalent). Leave blank if your org doesn't use custom statuses. |

---

## Permanent-access members (optional)

Some clubs give a membership tier (e.g. a gym add-on) a permanent 24/7 UniFi credential set up outside of CourtPin. Without this setting, when that member books a court, CourtPin still tries to issue them a second, temporary PIN — which collides with their existing permanent one and (thanks to the collision-fallback ladder in `PIN_MODE=static`) ends up emailing them a different, confusing code instead of failing outright.

Setting this makes CourtPin look the member up via CourtReserve's member API before creating a Visitor, and if they match, skip issuing a new PIN — the confirmation email still goes out, but with their existing PIN instead of a new one, and no UniFi Visitor is created.

| Variable | Required | Default | Description |
|---|---|---|---|
| `PERMANENT_ACCESS_MEMBERSHIP_KEYWORD` | No | — | A keyword matched case-insensitively (substring) against CourtReserve's `MembershipTypeName` — e.g. `Gym` matches `Pro + Gym`, `Family + Gym`, etc. Only members with an **Active** membership status are matched. Leave blank to disable (default) — every member gets a normal temporary PIN per reservation. |

**Requires `PIN_MODE=static`.** The email sent to a matched member reuses the same `deriveStaticPin()` value CourtPin would otherwise have assigned as a new PIN — that's the only way to know what their permanent PIN already is, since UniFi never returns a PIN's plaintext on read, only a hash. If your gym members' permanent PINs weren't set to that same derivation, this feature will show them the wrong code — don't enable it in that case. Setting this keyword while `PIN_MODE=random` has no effect (logged as a startup warning).

This currently applies to plain reservations and `EVENT_ACCESS_MODE=pin_individual` event registrations — not `pin_shared` or `unlock` mode, where there's one shared credential for the whole event rather than one per registrant.
