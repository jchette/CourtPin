# Auto Check-In on Door PIN Entry (optional)

Normally a member does two separate things to get on court: enter their door PIN (delivered by CourtPin), then separately check in at a `courtreserve-kiosk` touchscreen (or the CourtReserve app). This feature collapses that into one action — entering the door PIN at the keypad also submits the CourtReserve check-in automatically.

This is **additive**, not a replacement — CourtPin's existing PIN delivery (email/SMS) works exactly the same whether this is enabled or not. A member can still use the kiosk touchscreen if they prefer; nothing about this feature changes or depends on it.

**Scope: plain court reservations and `EVENT_ACCESS_MODE=pin_individual` event registrations.** `pin_shared` and `unlock` events are not auto-checked-in — see "Known limitations" below.

---

## How it works

1. UniFi Access's **Alarm Manager** fires a webhook to CourtPin whenever a door is unlocked.
2. CourtPin checks whether the unlock was a **PIN entry** (not a touch pass, remote/app unlock, etc.) and whether the direction is `entered`.
3. It matches the webhook's visitor UUID against the visitor CourtPin created when it issued that PIN, recovering the CourtReserve member ID and reservation ID.
4. It calls CourtReserve's official `POST /api/v1/checkins` API to check that member in — the same call an admin makes from CourtReserve's own check-in interface.

No new CourtReserve credentials, no physical kiosk registration, no cookie-session hacking — this reuses your existing `CR_ORG_ID`/`CR_API_KEY` Basic Auth.

---

## Setup

### 1. Enable the Check-In role on your API key

In CourtReserve admin → Settings → API Access, edit your existing API key and enable the **Check-In** role with **Write** permission (in addition to whatever roles it already has for `ReservationReport`/`EventRegistrationReport`).

**If "Check-In" doesn't appear in the role list at all:** confirmed in production that this can happen — the role isn't assignable to a scoped API key for every organization, even though the endpoint exists in CourtReserve's public API spec. A scoped key without it gets a flat `{"Message":"Authorization has been denied for this request."}` from `/api/v1/checkins`, before even reaching check-in logic. If you hit this, contact CourtReserve support and ask them to enable the Check-In role for your organization/API key — don't work around it by using an unrestricted/full-access API token for this integration long-term, since that's a much bigger blast radius if `CR_API_KEY` is ever compromised than a narrowly-scoped key.

### 2. Set environment variables

| Variable | Required | Description |
|---|---|---|
| `AUTO_CHECKIN_ENABLED` | No (default `false`) | Set `true` to turn the feature on. |
| `CHECKIN_WEBHOOK_SECRET` | If enabled | A long random string. UniFi's Alarm Manager has no HMAC signing option, so this is checked as a `?secret=` query parameter on the webhook URL instead — the only auth mechanism available. |
| `CHECKIN_STATUS_ID` | If your org uses custom Check-In Statuses | See "Finding your Check-In Status ID" below. Leave blank if your org doesn't have custom statuses configured. |

### Finding your Check-In Status ID

Some CourtReserve orgs have **Settings → Check-In Statuses** enabled (e.g. "Checked-In", "Late Arrival", "No-Show"). If yours does, the check-in API rejects requests without a `CheckInStatusId` — confirmed in production with the error `"CheckInStatusId is required because this organization uses check-in statuses."` The admin UI's Check-In Statuses page only shows names, not the numeric IDs the API needs, so:

1. Log into CourtReserve admin.
2. Visit `https://app.courtreserve.com/CheckInStatus/GetCheckInStatuses` directly in the same browser tab (it reuses your logged-in session).
3. You'll get raw JSON like:
   ```json
   {"Data":[{"Id":8346,"Name":"Checked-In",...},{"Id":8347,"Name":"Late Arrival",...}],...}
   ```
4. Use the `Id` for whichever status represents a normal check-in (usually "Checked-In") as `CHECKIN_STATUS_ID`.

If your org doesn't use custom check-in statuses, leave `CHECKIN_STATUS_ID` blank — the field is only sent to CourtReserve when set.

See [configuration.md](configuration.md#auto-check-in-optional) for the full reference.

### 3. Configure UniFi's Alarm Manager

In the UniFi Access console:

1. Go to **Alarm Manager** → create a new alarm (or reuse one).
2. **Trigger:** `Door unlocked`, scoped to your entry door(s) — don't scope it to every door in the system, to avoid unrelated noise (interior doors, etc.).
3. **Action:** `Webhook`.
4. **Delivery URL:** `https://<your-railway-domain>/webhook/unifi-unlock?secret=<CHECKIN_WEBHOOK_SECRET>`
5. **Delivery Method:** `POST`.

That's it — no port forwarding or on-site listener needed, since CourtPin already has a public HTTPS URL on Railway.

---

## Behavior notes

- **Only PIN entries trigger a check-in.** Touch pass, remote/app unlocks, and other credential types are ignored (logged as `not_pin_entry`).
- **Only entries, not exits.** A PIN used to exit is ignored.
- **Duplicate/repeat unlocks are deduped.** Once a check-in succeeds, the matched record is marked with a `checkedInAt` timestamp — a second unlock in the same session won't re-submit (logged as `already_checked_in`).
- **Unmatched visitors are skipped, not errored.** If the webhook's visitor UUID doesn't match anything CourtPin has on file (e.g. someone entered before CourtPin ever processed their reservation, or `state.json` was wiped by a Railway redeploy — see the state-file caveat in the main `CLAUDE.md`), it's logged as `no_match` and nothing else happens.

## Known limitations

- **`pin_shared` and `unlock` events aren't supported.** Those modes use one shared visitor/PIN (or no PIN at all, for `unlock`) for every registrant, so the webhook's visitor UUID can't identify which specific registrant unlocked the door. A PIN unlock matched to one of these entries is logged as `unsupported_entry_type` and skipped.
- **`pin_individual` events depend on a same-day CourtReserve lookup succeeding.** Since `EventRegistrationReport` doesn't expose a `ReservationId` (only `EventId`/`EventDateId`), CourtPin resolves it via a separate call to `/api/v1/eventcalendar/eventlist`, matching on `EventId` + the session's start/end time. If that lookup fails or finds no match (e.g. a CourtReserve outage, or the session got auto-cancelled — see below — before the lookup ran), the registrant still gets their PIN as normal, they just won't be eligible for auto check-in that session; a PIN unlock for them is logged as `unsupported_entry_type` the same as `pin_shared`/`unlock`.
- **An auto-cancelled event's `ReservationId` can still be resolved and matched, but check-in against it will fail.** If your CourtReserve org auto-cancels low-participation events to free up courts, an already-cancelled session's `ReservationId` is still returned by `eventlist` (`status=All` is used deliberately so it's still matched) — but the actual `POST /api/v1/checkins` call against it will fail with a normal CourtReserve error, logged as `checkin_failed`, the same as a check-in attempt against any other ended/cancelled reservation.
- **The webhook secret is a low-value shared secret, not a real credential.** It's visible in plain text in UniFi's Alarm Manager configuration UI and in HTTP access logs. Treat it accordingly — it prevents casual/accidental hits on the endpoint, not a determined attacker. If you rotate it, update both `CHECKIN_WEBHOOK_SECRET` and the Alarm Manager's Delivery URL together.

## Troubleshooting

| Symptom in logs | Cause |
|---|---|
| `no_match` | Either the member entered before CourtPin processed their reservation, or `state.json` was reset (e.g. a Railway redeploy without a persistent volume — see `docs/hosting.md`). |
| `unsupported_entry_type` | Either the matched visitor came from a `pin_shared`/`unlock` event (not supported — see above), or it's a `pin_individual` event registrant whose `ReservationId` lookup failed or found no match. |
| `checkin_failed` — `"Authorization has been denied for this request."` | The `Check-In` role isn't enabled on `CR_API_KEY`. It may not even appear as an assignable role in your API Access settings — this has been confirmed to happen. Contact CourtReserve support to have it enabled; see the note in Setup step 1. |
| `checkin_failed` — `"CheckInStatusId is required because this organization uses check-in statuses."` | Your org has custom Check-In Statuses enabled and `CHECKIN_STATUS_ID` isn't set. See "Finding your Check-In Status ID" above. |
| `checkin_failed` with any other CourtReserve error message | Often means the reservation has already ended or been cancelled. |
| Webhook never arrives | Confirm the Alarm Manager's Delivery URL exactly matches your Railway domain and includes the correct `?secret=` value; confirm the alarm's trigger is scoped to the door actually being used. |
