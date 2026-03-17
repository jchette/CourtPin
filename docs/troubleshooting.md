# Troubleshooting

This guide covers every common issue with CourtPin. Each entry includes the symptom, the likely cause, and the fix.

If your issue is not listed here, open a GitHub Issue with your log output and environment details.

---

## Reading the logs

All CourtPin activity is logged to stdout with a timestamp and level. On Railway: service → Deployments → latest → View Logs.

```
[2026-03-15T12:00:00.000Z] [INFO]  CourtReserve <-> UniFi Access integration starting
[2026-03-15T12:00:00.000Z] [INFO]  Email transport: Resend
[2026-03-15T12:00:00.000Z] [INFO]  Fetched 2 reservation(s)
[2026-03-15T12:01:00.000Z] [DEBUG] Reservation timing check {"reservationId":"50786225",...}
[2026-03-15T12:01:00.000Z] [INFO]  Processing player {"memberId":1788252,...}
[2026-03-15T12:01:02.000Z] [INFO]  ✅ Player processed successfully {"pin":"67203419",...}
```

Log levels: `debug`, `info`, `warn`, `error`.

---

## Startup errors

### Missing required environment variables

**Symptom:**
```
❌ Missing required environment variables: CR_ORG_ID, CR_API_KEY
```

**Fix:** Open Railway → Variables tab and confirm every required variable has a value. See [configuration.md](configuration.md) for the full list of required variables.

---

### No email transport configured

**Symptom:**
```
❌ No email transport configured.
```

**Fix:** Set either `RESEND_API_KEY` (for Resend) or `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` (for SMTP). At least one must be configured. See [email-setup.md](email-setup.md).

---

## CourtReserve issues

### Fetched 0 reservations — reservation exists in CourtReserve

**Symptom:** Logs show `Fetched 0 reservation(s)` but you can see a reservation in CourtReserve.

**Most likely cause: wrong timezone.** Railway runs in UTC. Without `TZ` set, CourtPin queries the wrong date and misses all reservations.

**Fix:**
1. Confirm `TZ=America/New_York` (or your timezone) is set in Railway Variables
2. If it was missing, add it — Railway will redeploy automatically
3. Check the debug log: `localNow` should show your local time, not UTC

Other possible causes:
- The reservation was already in the past when CourtPin checked
- Wrong `CR_ORG_ID` or `CR_API_KEY`
- ReservationReport → Read permission not enabled on the API key

---

### CourtReserve API error: Unauthorized

**Symptom:**
```
CourtReserve API error: {"ErrorMessage":"Unauthorized",...}
```

**Fix:** Check `CR_ORG_ID` and `CR_API_KEY`. The org ID is the number in your CourtReserve admin URL after `/organization/`. The API key is found in Admin → Settings → API Access.

---

### CourtReserve API error: Forbidden

**Symptom:**
```
CourtReserve API error: {"ErrorMessage":"Forbidden",...}
```

**Fix:** The API key is missing the required permission. In CourtReserve Admin → Settings → API Access, edit your key and ensure **ReservationReport → Read** is checked.

---

### CourtReserve API error: date range exceeds 31 days

**Symptom:**
```
CourtReserve API error: Currently, this report cannot be run for a period longer than 31 days
```

**Fix:** This happens if `NOTIFY_MINUTES_BEFORE` is set to a very large value (like `1440`) and the query range crosses midnight. Set it back to `60` for normal operation. Use `1440` only temporarily for testing.

---

### Reservation processed multiple times — duplicate emails

**Symptom:** A member receives duplicate PIN emails for the same reservation.

**Cause:** The state file was reset. This can happen if Railway restarted and cleared `/tmp/state.json`, or if `STATE_FILE` was changed to a new path.

**Fix:** This is harmless — the member just receives an extra notification. Duplicate Visitor records in UniFi are cleaned up automatically after the reservation ends. To reduce frequency, consider a more persistent storage option (see [CONTRIBUTING.md](../CONTRIBUTING.md) for ideas).

---

## UniFi Access issues

### Create visitor failed: CODE_UNAUTHORIZED

**Symptom:**
```
Failed to create UniFi visitor {"err":"Create visitor failed: {\"code\":\"CODE_UNAUTHORIZED\",...}"}
```

**Fix:** The API token is missing required scopes. Delete it and create a new one in UniFi Portal → Access → Settings → General → Advanced → API Token with both `view:credential` and `edit:visitor` checked.

---

### Connection timeout

**Symptom:**
```
Failed to create UniFi visitor {"err":"timeout of 15000ms exceeded"}
```

**Cause:** Railway (or your VPS) cannot reach your UniFi console.

**Fix:** Work through [unifi-setup.md](unifi-setup.md) — Making UniFi reachable from the internet. Specifically check:

1. Port forwarding rule is saved in UniFi (WAN Port 12445 → Forward Port 12445)
2. Firewall rule exists (Internet Local or Internet In, TCP, port 12445)
3. [portchecker.co](https://portchecker.co) shows port `12445` as **Open** on your public IP
4. `UNIFI_HOST` in Railway matches your public IP or DuckDNS hostname exactly
5. If using DuckDNS, the updater is running and your IP is current

---

### PIN generation failed

**Symptom:**
```
Failed to generate/assign PIN {"err":"PIN generation failed:..."}
```

**Fix:** The API token is missing `view:credential` scope. Delete and recreate the token with both required scopes.

---

### Visitor records not deleted after reservations end

**Symptom:** Old Visitor records remain in UniFi Access long after reservations have ended.

**Fix:** CourtPin deletes expired visitors every minute, `CLEANUP_BUFFER_MINUTES` after end time. If records persist check:
1. Railway service is still running (Deployments tab)
2. `CLEANUP_BUFFER_MINUTES` is set correctly (default: 15)
3. UniFi API token is still valid and has `edit:visitor` permission

---

## Email issues

### Failed to send email — Connection timeout (SMTP on Railway)

**Symptom:**
```
Failed to send email {"err":"Connection timeout"}
```

**Cause:** Railway blocks outbound SMTP ports (25, 465, 587) on free and hobby tiers.

**Fix:** Switch to Resend. Set `RESEND_API_KEY` and leave `SMTP_*` variables blank. Resend sends over HTTPS (port 443) which Railway never blocks. See [email-setup.md](email-setup.md).

---

### Failed to send email — Resend

**Symptom:**
```
Failed to send email {"err":"..."}
```

**Fix:**
1. Log into resend.com and confirm your API key exists and has Sending access
2. Confirm your domain shows **Verified** in Resend → Domains
3. Ensure `EMAIL_FROM` uses an address at your verified domain
4. For testing, try `EMAIL_FROM=onboarding@resend.dev`

---

### Failed to send email — SMTP authentication

**Symptom:**
```
Failed to send email {"err":"Invalid login"}
```
or
```
Failed to send email {"err":"535 Authentication failed"}
```

**Fix:**
1. Confirm `SMTP_USER` and `SMTP_PASS` are correct
2. If using Gmail, you need an App Password — your regular Google password does not work for SMTP. See [email-setup.md](email-setup.md)
3. Confirm `SMTP_HOST` and `SMTP_PORT` match your provider's settings exactly

---

## SMS issues

### SMS not sending

**Symptom:** Email arrives but no SMS is sent.

**Fix:**
1. Confirm `TWILIO_ENABLED=true`
2. Confirm `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` are all set correctly
3. The member must have a phone number stored in CourtReserve — CourtPin skips SMS silently if no phone number is found
4. On a Twilio free trial, you can only send to verified numbers. Go to twilio.com/console → Verified Caller IDs to add numbers, or upgrade your account

---

## Admin portal issues

### Admin portal not accessible

**Symptom:** The `/admin` URL returns an error or does not load.

**Fix:**
1. Confirm `PORT=3000` and `ADMIN_PORT=3000` are both set in Railway Variables
2. Go to Railway → your service → **Settings → Networking** and confirm a domain has been generated. If not, click **Generate Domain**.
3. Check the Deployments tab — confirm the latest deployment succeeded

---

### PIN rejected when using static mode

**Symptom:** `Failed to assign PIN` error in logs when `PIN_MODE=static` is set.

**Cause:** UniFi Access is configured for a fixed PIN length (4, 6, or 8 digits) but the CourtReserve `OrganizationMemberId` is 7 digits and does not match.

**Fix:** In UniFi Access go to **Settings → General → PIN** and change from Fixed Length to **Variable Length**, then save. CourtPin will retry on the next cycle.

---

### Static mode PIN not working at the door

**Symptom:** Member enters their member ID at the keypad but access is denied.

**Possible causes:**
1. UniFi PIN mode is still set to Fixed Length — change to Variable Length as above
2. Member is entering the wrong number — confirm their `OrganizationMemberId` in CourtReserve Admin → Members
3. `PIN_MODE` variable is still set to `random` in Railway — confirm it is set to `static`

---

### PIN shows as "not stored" in admin portal

**Symptom:** A reservation card shows "PIN not stored for this record."

**Cause:** This reservation was processed before PIN logging was added (an earlier version of CourtPin), or the state file was reset before the PIN was written.

**Fix:**
1. Check Railway logs and search for the reservation ID — the PIN is logged at processing time: `[INFO] ✅ Player processed successfully {"pin":"67203419",...}`
2. Check UniFi Access → Visitors — the Visitor record may still be active
3. To force reprocessing: rename `STATE_FILE` to a new path (e.g. `/tmp/state_new.json`) — CourtPin will treat all reservations as unprocessed and re-send PINs

---

## Timing issues

### PIN becomes active at the wrong time

**Symptom:** Members can enter too early, or the PIN is not active when they arrive.

**Fix:**
- Confirm `TZ` matches your facility's timezone exactly (e.g. `America/New_York` not `EST`)
- `ACCESS_BUFFER_MINUTES` controls how early the PIN activates before reservation start (default: 30)
- If times are consistently off by a fixed number of hours, `TZ` is wrong

---

### Reservations are picked up too early or too late

**Symptom:** Members receive their PIN at unexpected times.

**Fix:** `NOTIFY_MINUTES_BEFORE` controls when the PIN is sent relative to reservation start. Default is `60` (1 hour before). Adjust to your preference.

---

## General

### Service keeps restarting on Railway

**Symptom:** Railway shows frequent restarts in the Deployments tab.

**Fix:** Check the logs just before each restart for an error message. Common causes:
- A missing required environment variable causes an immediate exit on startup
- An uncaught error in the code (please open a GitHub Issue with the log output)

---

### State file issues after Railway restart

**Symptom:** After a Railway restart, previously processed reservations are processed again.

**Cause:** Railway's `/tmp` directory is ephemeral — it is cleared when the container restarts.

**Fix:** This is a known limitation of the current state file approach. The practical impact is minimal — members receive a duplicate PIN email at worst, and the PIN and access window are the same. For a more persistent solution, see the persistent state storage idea in [CONTRIBUTING.md](../CONTRIBUTING.md).
