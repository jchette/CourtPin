/**
 * CourtReserve <-> UniFi Access Integration
 *
 * Flow:
 *  1. Poll CourtReserve every minute for today's active reservations and events.
 *  2. For each reservation within the notification window (not yet processed):
 *     a. Create a Visitor in UniFi Access scoped to the reservation window.
 *     b. Generate or derive a PIN (random or static member ID).
 *     c. Assign the PIN to the Visitor.
 *     d. Email the member their PIN via Resend or SMTP.
 *     e. Optionally SMS the member via Twilio.
 *  3. For each event registration within the notification window:
 *     - pin_individual: each registrant gets their own Visitor + PIN
 *     - pin_shared:     one Visitor + PIN shared across all registrants
 *     - unlock:         door(s) unlocked for the event duration, optional notification
 *  4. After reservations/events end + cleanup buffer, delete Visitors.
 *  5. Serve a mobile-friendly admin portal for PIN lookup and resend.
 *
 * Required CourtReserve API roles : ReservationReport (Read), EventRegistrationReport (Read)
 * Required UniFi Access scopes    : view:credential, edit:visitor
 */

'use strict';

require('dotenv').config();
const axios      = require('axios');
const nodemailer = require('nodemailer');
const https = require('https');
const http  = require('http');
const cron  = require('node-cron');
const fs    = require('fs');
const path  = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────

const config = {
  courtreserve: {
    baseUrl: process.env.CR_BASE_URL || 'https://api.courtreserve.com',
    orgId:   process.env.CR_ORG_ID,
    apiKey:  process.env.CR_API_KEY,
  },
  unifi: {
    host:      process.env.UNIFI_HOST,
    token:     process.env.UNIFI_API_TOKEN,
    resources: parseResources(process.env.UNIFI_RESOURCES),
  },
  email: {
    // Transport mode:
    //   If RESEND_API_KEY is set → use Resend (recommended for Railway / cloud)
    //   Otherwise              → use SMTP nodemailer (recommended for local/self-hosted)
    resendApiKey: process.env.RESEND_API_KEY || '',
    from:         process.env.EMAIL_FROM     || '',
    smtp: {
      host:   process.env.SMTP_HOST   || '',
      port:   parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true', // true for port 465, false for 587/STARTTLS
      user:   process.env.SMTP_USER   || '',
      pass:   process.env.SMTP_PASS   || '',
      debug:  process.env.SMTP_DEBUG === 'true', // logs the full SMTP conversation incl. AUTH — troubleshooting only, disable after use
    },
  },
  twilio: {
    enabled:    process.env.TWILIO_ENABLED === 'true',
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken:  process.env.TWILIO_AUTH_TOKEN  || '',
    fromNumber: process.env.TWILIO_FROM_NUMBER || '',
  },
  brand: {
    clubName:    process.env.BRAND_CLUB_NAME    || 'Our Club',
    tagline:     process.env.BRAND_TAGLINE      || '',
    headerColor: '#' + (process.env.BRAND_HEADER_COLOR || '1a56db').replace(/^#/, ''),
    accentColor: '#' + (process.env.BRAND_ACCENT_COLOR || '1a56db').replace(/^#/, ''),
    website:     process.env.BRAND_WEBSITE || '',
    phone:       process.env.BRAND_PHONE   || '',
    address:     process.env.BRAND_ADDRESS || '',
  },
  notifyMinutesBefore:  parseInt(process.env.NOTIFY_MINUTES_BEFORE  || '60', 10),
  accessBufferMinutes:  parseInt(process.env.ACCESS_BUFFER_MINUTES  || '30', 10),
  cleanupBufferMinutes: parseInt(process.env.CLEANUP_BUFFER_MINUTES || '15', 10),
  stateFile:   process.env.STATE_FILE   || path.join(__dirname, 'state.json'),
  adminPort:   parseInt(process.env.ADMIN_PORT || '3000', 10),
  adminSecret: process.env.ADMIN_SECRET || '',
  pinMode:     process.env.PIN_MODE === 'static' ? 'static' : 'random',
  // static — uses CourtReserve OrganizationMemberId as PIN (consistent, member learns once)
  // random  — generates a new random PIN each reservation (default)
  //
  // STATIC_PIN_LENGTH controls how much of the OrganizationMemberId is used
  // when PIN_MODE=static. This is a property of the UniFi installation (its
  // configured PIN length) and applies universally to both reservations and
  // events — not per-booking.
  //   full — use the entire OrganizationMemberId, whatever length it is (default)
  //   4/6/8/etc — use only the last N digits of the OrganizationMemberId
  //               (matches a fixed PIN length configured on the UniFi side,
  //               e.g. Fabric sites defaulting Smart Door Access to Fixed 4-digit —
  //               see docs/troubleshooting.md for the Fabric Identity Settings fix)
  staticPinLength: process.env.STATIC_PIN_LENGTH || 'full',
  events: {
    // How door access is granted to event registrants:
    //   pin_individual — each registrant gets their own unique PIN (default)
    //   pin_shared     — one PIN generated for the event, sent to all registrants
    //   unlock         — door(s) unlocked for the event duration, no PINs
    accessMode:          process.env.EVENT_ACCESS_MODE || 'pin_individual',
    accessBufferMinutes: parseInt(process.env.EVENT_ACCESS_BUFFER_MINUTES || '30', 10),
    // unlock mode only: send an email/SMS notification that the facility is open
    unlockNotify:        process.env.EVENT_UNLOCK_NOTIFY === 'true',
  },
  checkin: {
    // Optional feature: a UniFi Access PIN-code door unlock automatically submits
    // a CourtReserve check-in for that member, via POST /api/v1/checkins — reuses
    // the existing CR_ORG_ID/CR_API_KEY Basic Auth (requires the Check-In role
    // with Write permission enabled on that key). See docs/auto-checkin.md.
    enabled:       process.env.AUTO_CHECKIN_ENABLED === 'true',
    webhookSecret: process.env.CHECKIN_WEBHOOK_SECRET || '',
    // Some CourtReserve orgs have "check-in statuses" enabled (Settings →
    // Check-In Statuses), in which case the API rejects a check-in without a
    // CheckInStatusId — confirmed in production ("CheckInStatusId is required
    // because this organization uses check-in statuses"). Not every org needs
    // this, so it's optional here; leave unset if your org doesn't use custom
    // statuses. Find the numeric ID via /CheckInStatus/GetCheckInStatuses on
    // your CourtReserve admin domain (see docs/auto-checkin.md).
    statusId:      process.env.CHECKIN_STATUS_ID ? parseInt(process.env.CHECKIN_STATUS_ID, 10) : null,
  },
  permanentAccess: {
    // Optional: some clubs give a membership tier (e.g. "Pro + Gym") a permanent
    // 24/7 UniFi credential outside of CourtPin. When such a member books a court,
    // issuing them a second temporary PIN just collides with their existing one
    // and confuses them with a different code — see processReservation/processEvents.
    // Matched case-insensitively against CourtReserve's MembershipTypeName
    // (substring match, so "Gym" also matches "Pro + Gym", "Family + Gym", etc).
    // Empty/unset disables this feature entirely (default).
    membershipKeyword: process.env.PERMANENT_ACCESS_MEMBERSHIP_KEYWORD || '',
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseResources(raw) {
  if (!raw) return [];
  return raw.split(',').map(entry => {
    const [type, id] = entry.trim().split(':');
    return { type, id };
  }).filter(r => r.type && r.id);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(config.stateFile, 'utf8')); }
  catch { return { processed: {} }; }
}

function saveState(state) {
  fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
}

function findProcessedByVisitorId(state, visitorId) {
  return Object.entries(state.processed).find(([, v]) => v.visitorId === visitorId);
}

function log(level, msg, meta = {}) {
  const ts      = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${ts}] [${level.toUpperCase()}] ${msg}${metaStr}`);
}

function toEpoch(dt) {
  return Math.floor(new Date(dt).getTime() / 1000);
}

function fmtDate(dt) {
  return new Date(dt).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function fmtLocalDatetime(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
         `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function deriveStaticPin(memberId) {
  // Converts a CourtReserve OrganizationMemberId into a static PIN according
  // to config.staticPinLength ('full' or a specific digit count like 4 or 6).
  const idStr = String(memberId);
  if (config.staticPinLength === 'full') return idStr;

  const length = parseInt(config.staticPinLength, 10);
  if (!length || length <= 0) return idStr; // invalid value — fall back to full ID

  return idStr.slice(-length); // last N digits
}

function staticPinCandidates(memberId) {
  // Two different members can share the same last-N digits of their member ID
  // (e.g. STATIC_PIN_LENGTH=4 has only 10,000 possible values), and UniFi
  // rejects assigning a PIN that's already active on another visitor. Builds
  // a ladder of increasingly specific candidates — starting at the configured
  // length and growing one digit at a time up to the full member ID — so a
  // collision on the short PIN can be retried with a longer, less-likely-to-
  // collide one instead of failing outright.
  const idStr = String(memberId);
  const base  = deriveStaticPin(memberId);
  const candidates = [base];
  for (let len = base.length + 1; len <= idStr.length; len++) {
    candidates.push(idStr.slice(-len));
  }
  return candidates;
}

// ─── HTTP Clients ─────────────────────────────────────────────────────────────

const courtreserve = axios.create({
  baseURL: config.courtreserve.baseUrl,
  auth:    { username: config.courtreserve.orgId, password: config.courtreserve.apiKey },
  headers: { Accept: 'application/json' },
  timeout: 20_000,
});

const unifi = axios.create({
  baseURL:    config.unifi.host,
  headers:    { Authorization: `Bearer ${config.unifi.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  timeout:    15_000,
});

// ─── Email ────────────────────────────────────────────────────────────────────

async function sendUnlockNotificationEmail({ to, memberName, eventName, startDate, endDate, accessBufferMinutes }) {
  const b           = config.brand;
  const startStr    = fmtDate(startDate);
  const endStr      = fmtDate(endDate);
  const accessStart = new Date(startDate.getTime() - accessBufferMinutes * 60_000);
  const accessStr   = fmtDate(accessStart);

  const contactLines = [
    b.phone   ? `📞 ${b.phone}`   : '',
    b.website ? `🌐 ${b.website}` : '',
    b.address ? `📍 ${b.address}` : '',
  ].filter(Boolean).join('&nbsp;&nbsp;·&nbsp;&nbsp;');

  // Styles are inlined on every element rather than left in a <style> block —
  // some clients (confirmed: new Outlook desktop) don't reliably apply
  // class-based CSS from <head> and silently fall back to unstyled text.
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
</head>
<body style="font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 0;">
  <div style="max-width: 600px; margin: 40px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.1);">
    <div style="background: ${b.headerColor}; color: #fff; padding: 28px 32px; text-align: center;">
      <h1 style="margin: 0; font-size: 24px; font-weight: 700;">${b.clubName}</h1>
      ${b.tagline ? `<p style="margin: 6px 0 0; font-size: 13px; opacity: .85;">${b.tagline}</p>` : ''}
    </div>
    <div style="padding: 32px; color: #333;">
      <p style="font-size:16px; margin:0;">Hi <strong>${memberName}</strong>,</p>
      <p style="margin-top:8px; color:#555;">Your upcoming event is almost here! The facility will be unlocked and ready for you.</p>
      <div style="background: #f0fff8; border: 2px solid ${b.accentColor}; border-radius: 10px; text-align: center; margin: 24px 0; padding: 24px;">
        <div style="font-size: 22px; font-weight: bold; color: ${b.accentColor};">Facility Open</div>
        <div style="font-size: 13px; color: #555; margin-top: 8px;">No PIN required — doors will be unlocked for your event</div>
        <div style="font-size: 13px; color:${b.accentColor}; font-weight:600; margin-top:6px;">Open from ${accessStr}</div>
      </div>
      <div style="background: #f9f9f9; border-radius: 8px; padding: 16px; margin-top: 16px; border-left: 4px solid ${b.accentColor};">
        <p style="margin: 6px 0; font-size: 14px;">📅 <strong>Event:</strong> ${eventName}</p>
        <p style="margin: 6px 0; font-size: 14px;">🕐 <strong>Start:</strong> ${startStr}</p>
        <p style="margin: 6px 0; font-size: 14px;">🕑 <strong>End:</strong>   ${endStr}</p>
      </div>
    </div>
    <div style="text-align: center; font-size: 12px; color: #aaa; padding: 20px 16px; border-top: 1px solid #f0f0f0; line-height: 1.8;">
      <strong style="color: #888;">${b.clubName}</strong><br/>
      ${contactLines ? `${contactLines}<br/>` : ''}
      This is an automated message — please do not reply to this email.
    </div>
  </div>
</body>
</html>`;

  const subject = `${b.clubName} Access PIN - ${fmtDate(startDate)}`;
  await _sendEmail(to, subject, html);
  log('info', 'Unlock notification email sent', { to });
}

async function sendUnlockNotificationSms({ to, memberName, eventName, startDate, accessBufferMinutes }) {
  const b           = config.brand;
  const accessStart = new Date(startDate.getTime() - accessBufferMinutes * 60_000);
  const fmtShort    = dt => new Date(dt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const body = [
    `${b.clubName}`,
    `Facility Access`,
    ``,
    `Hi ${memberName},`,
    `Event: ${eventName}`,
    `Doors open: ${fmtShort(accessStart)}`,
    ``,
    `No PIN needed — the facility will be unlocked for your event.`,
  ].join('\n');

  const cleaned = to.replace(/\D/g, '');
  const e164    = cleaned.startsWith('1') ? `+${cleaned}` : `+1${cleaned}`;

  const resp = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Messages.json`,
    new URLSearchParams({ From: config.twilio.fromNumber, To: e164, Body: body }).toString(),
    { auth: { username: config.twilio.accountSid, password: config.twilio.authToken }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 }
  );
  if (resp.data?.sid) { log('info', 'Unlock notification SMS sent', { to: e164, sid: resp.data.sid }); }
  else { throw new Error(`Twilio unexpected response: ${JSON.stringify(resp.data)}`); }
}

async function sendAccessEmail({ to, memberName, pin, startDate, endDate, courts, accessBufferMinutes, courtLabel = 'Court' }) {
  const b           = config.brand;
  const startStr    = fmtDate(startDate);
  const endStr      = fmtDate(endDate);
  const courtStr    = courts || 'Reserved Court';
  const accessStart = new Date(startDate.getTime() - accessBufferMinutes * 60_000);
  const accessStr   = fmtDate(accessStart);

  const contactLines = [
    b.phone   ? `📞 ${b.phone}`   : '',
    b.website ? `🌐 ${b.website}` : '',
    b.address ? `📍 ${b.address}` : '',
  ].filter(Boolean).join('&nbsp;&nbsp;·&nbsp;&nbsp;');

  // Styles are inlined on every element rather than left in a <style> block —
  // some clients (confirmed: new Outlook desktop) don't reliably apply
  // class-based CSS from <head> and silently fall back to unstyled text,
  // which is exactly how the PIN itself was reported rendering unstyled.
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
</head>
<body style="font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 0;">
  <div style="max-width: 600px; margin: 40px auto; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.1);">
    <div style="background: ${b.headerColor}; color: #fff; padding: 28px 32px; text-align: center;">
      <h1 style="margin: 0; font-size: 24px; font-weight: 700;">${b.clubName}</h1>
      ${b.tagline ? `<p style="margin: 6px 0 0; font-size: 13px; opacity: .85;">${b.tagline}</p>` : ''}
    </div>
    <div style="padding: 32px; color: #333;">
      <p style="font-size:16px; margin:0;">Hi <strong>${memberName}</strong>,</p>
      <p style="margin-top:8px; color:#555;">Your reservation is coming up! Use the PIN below to access the building.</p>
      <div style="background: #f5f7ff; border: 2px dashed ${b.accentColor}; border-radius: 10px; text-align: center; margin: 24px 0; padding: 24px;">
        <div style="font-size: 52px; font-weight: bold; letter-spacing: 14px; color: ${b.accentColor};">${pin}</div>
        <div style="font-size: 13px; color: #666; margin-top: 6px;">Enter this PIN at the front door keypad</div>
        <div style="font-size: 13px; color: ${b.accentColor}; font-weight: 600; margin-top: 6px;">Active from ${accessStr}</div>
      </div>
      <div style="background: #f9f9f9; border-radius: 8px; padding: 16px; margin-top: 16px; border-left: 4px solid ${b.accentColor};">
        <p style="margin: 6px 0; font-size: 14px;">🎾 <strong>${courtLabel}:</strong> ${courtStr}</p>
        <p style="margin: 6px 0; font-size: 14px;">🕐 <strong>Start:</strong> ${startStr}</p>
        <p style="margin: 6px 0; font-size: 14px;">🕑 <strong>End:</strong>   ${endStr}</p>
      </div>
      <div style="margin-top: 24px; font-size: 13px; color: #777; line-height: 1.6; background: #fffbf0; border-radius: 6px; padding: 12px 16px; border: 1px solid #ffe8a0;">
        ⏰ Your PIN becomes active <strong>${accessBufferMinutes} minutes before</strong> your
        reservation at <strong>${accessStr}</strong> and expires when your session ends.
        Please do not share your PIN. Contact the front desk with any questions.
      </div>
    </div>
    <div style="text-align: center; font-size: 12px; color: #aaa; padding: 20px 16px; border-top: 1px solid #f0f0f0; line-height: 1.8;">
      <strong style="color: #888;">${b.clubName}</strong><br/>
      ${contactLines ? `${contactLines}<br/>` : ''}
      This is an automated message — please do not reply to this email.
    </div>
  </div>
</body>
</html>`;

  const subject = `${b.clubName} Access PIN - ${startStr}`;
  await _sendEmail(to, subject, html);
  log('info', 'Access email sent', { to });
}

// ── Shared email transport helper ─────────────────────────────────────────────
async function _sendEmail(to, subject, html) {
  if (config.email.resendApiKey) {
    // Resend — recommended for cloud hosting (Railway), sends over HTTPS port 443
    const resp = await axios.post(
      'https://api.resend.com/emails',
      { from: config.email.from, to: [to], subject, html },
      { headers: { Authorization: `Bearer ${config.email.resendApiKey}`, 'Content-Type': 'application/json' }, timeout: 10_000 }
    );
    if (!resp.data?.id) throw new Error(`Resend unexpected response: ${JSON.stringify(resp.data)}`);
  } else {
    // SMTP via nodemailer — recommended for local / self-hosted setups
    const transporter = nodemailer.createTransport({
      host:   config.email.smtp.host,
      port:   config.email.smtp.port,
      secure: config.email.smtp.secure,
      auth:   { user: config.email.smtp.user, pass: config.email.smtp.pass },
      logger: config.email.smtp.debug,
      debug:  config.email.smtp.debug,
    });
    try {
      await transporter.sendMail({ from: config.email.from, to, subject, html });
    } catch (err) {
      // nodemailer attaches these fields for SMTP-level failures (auth, TLS, relay
      // rejection) — surface them here since callers otherwise only log err.message.
      log('error', 'SMTP send failed', {
        to,
        host:         config.email.smtp.host,
        port:         config.email.smtp.port,
        secure:       config.email.smtp.secure,
        code:         err.code,
        responseCode: err.responseCode,
        response:     err.response,
        command:      err.command,
        message:      err.message,
      });
      throw err;
    }
  }
}

// ─── SMS ──────────────────────────────────────────────────────────────────────

async function sendAccessSms({ to, memberName, pin, startDate, courts, accessBufferMinutes }) {
  const b           = config.brand;
  const accessStart = new Date(startDate.getTime() - accessBufferMinutes * 60_000);

  // Keep SMS under 160 characters to avoid splitting into 2 segments (doubles cost).
  // Uses a compact date format (Mar 15, 12:00 PM) instead of the full email format.
  const fmtShort = dt => new Date(dt).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  const courtStr = courts || 'Reserved Court';

  // SMS is designed to stand alone — a member who did not read their email
  // should still understand exactly what to do when they arrive at the door.
  const body = [
    `${b.clubName}`,
    `Your Door Access PIN`,
    ``,
    `PIN: ${pin}`,
    `Court: ${courtStr}`,
    `Reservation: ${fmtShort(startDate)}`,
    ``,
    `Enter this PIN at the front door keypad. Your PIN is active ${accessBufferMinutes} minutes before your reservation and is valid for this reservation only.`,
    ``,
    `Do not share this PIN.`,
  ].join('\n');

  const cleaned = to.replace(/\D/g, '');
  const e164    = cleaned.startsWith('1') ? `+${cleaned}` : `+1${cleaned}`;

  const resp = await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Messages.json`,
    new URLSearchParams({ From: config.twilio.fromNumber, To: e164, Body: body }).toString(),
    {
      auth:    { username: config.twilio.accountSid, password: config.twilio.authToken },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10_000,
    }
  );

  if (resp.data?.sid) {
    log('info', 'SMS sent', { to: e164, sid: resp.data.sid });
  } else {
    throw new Error(`Twilio unexpected response: ${JSON.stringify(resp.data)}`);
  }
}

// ─── CourtReserve API ─────────────────────────────────────────────────────────

async function fetchTodaysReservations() {
  const now        = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,  0,  0);
  const endOfDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

  log('debug', 'Querying CourtReserve', {
    from:     fmtLocalDatetime(startOfDay),
    to:       fmtLocalDatetime(endOfDay),
    localNow: now.toString(),
  });

  const resp = await courtreserve.get('/api/v1/reservationreport/listactive', {
    params: {
      reservationsFromDate: fmtLocalDatetime(startOfDay),
      reservationsToDate:   fmtLocalDatetime(endOfDay),
    },
  });

  log('debug', 'CourtReserve response', {
    isSuccess:   resp.data?.IsSuccessStatusCode,
    recordCount: resp.data?.Data?.length ?? 0,
    error:       resp.data?.ErrorMessage || null,
  });

  if (!resp.data?.IsSuccessStatusCode) {
    throw new Error(`CourtReserve API error: ${resp.data?.ErrorMessage || 'unknown'}`);
  }

  return resp.data.Data || [];
}

async function fetchTodaysEventRegistrations() {
  const now        = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,  0,  0);
  const endOfDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

  const resp = await courtreserve.get('/api/v1/eventregistrationreport/listactive', {
    params: {
      eventDateFrom: fmtLocalDatetime(startOfDay),
      eventDateTo:   fmtLocalDatetime(endOfDay),
      // Without this, CourtReserve silently excludes guest/public-booking
      // registrants from the response — confirmed in production, they don't
      // come back with a blank OrganizationMemberId, they just aren't there.
      includeGuests: true,
    },
  });

  log('debug', 'CourtReserve event registrations response', {
    isSuccess:   resp.data?.IsSuccessStatusCode,
    recordCount: resp.data?.Data?.length ?? 0,
  });

  if (!resp.data?.IsSuccessStatusCode) {
    throw new Error(`CourtReserve event API error: ${resp.data?.ErrorMessage || 'unknown'}`);
  }

  return resp.data.Data || [];
}

// Resolves the ReservationId for one event session — needed so pin_individual
// event registrants can be auto-checked-in via the PIN-unlock webhook (see
// processUnlockWebhookEvent), since EventRegistrationReport doesn't expose a
// ReservationId itself, only EventId/EventDateId. Queries eventlist scoped to
// the session's own day and matches client-side on EventId + StartDateTime/
// EndDateTime — eventlist has no EventDateId field, and its eventFilterId
// query param does NOT filter by EventId (confirmed against production: it
// returned zero rows for an EventId present in the same unfiltered date
// range), so don't rely on it. status: 'All' is required so a session
// already auto-cancelled (e.g. this club's low-participation auto-cancel,
// which frees the court) can still be matched — a stale/cancelled
// ReservationId just fails cleanly later at the actual check-in call.
async function fetchEventReservationId(eventId, sessionStart, sessionEnd) {
  const startOfDay = new Date(sessionStart.getFullYear(), sessionStart.getMonth(), sessionStart.getDate(), 0,  0,  0);
  const endOfDay   = new Date(sessionStart.getFullYear(), sessionStart.getMonth(), sessionStart.getDate(), 23, 59, 59);

  const resp = await courtreserve.get('/api/v1/eventcalendar/eventlist', {
    params: {
      startDate: fmtLocalDatetime(startOfDay),
      endDate:   fmtLocalDatetime(endOfDay),
      status:    'All',
    },
  });

  if (!resp.data?.IsSuccessStatusCode) {
    throw new Error(`CourtReserve eventlist API error: ${resp.data?.ErrorMessage || 'unknown'}`);
  }

  const rows  = resp.data.Data || [];
  const match = rows.find(row =>
    String(row.EventId) === String(eventId) &&
    new Date(row.StartDateTime).getTime() === sessionStart.getTime() &&
    new Date(row.EndDateTime).getTime()   === sessionEnd.getTime()
  );

  return match ? match.ReservationId : null;
}

// Looks up whether a member already holds a permanent 24/7 UniFi credential
// (see config.permanentAccess.membershipKeyword) via CourtReserve's member
// lookup, so processReservation/processEvents can skip issuing them a second,
// temporary PIN that would just collide with their existing one.
async function hasPermanentAccess(memberId) {
  // Only meaningful in PIN_MODE=static — that's the only mode where the PIN
  // reused for these members (deriveStaticPin) reflects a real credential.
  if (!config.permanentAccess.membershipKeyword || !memberId || config.pinMode !== 'static') return false;

  try {
    const resp = await courtreserve.get('/api/v1/member/get', {
      params: {
        organizationMemberId:     memberId,
        pageSize:                 1,
        pageNumber:                1,
        includeUserDefinedFields: false,
        includeRatings:           false,
      },
    });

    if (!resp.data?.IsSuccessStatusCode) return false;

    const member = resp.data.Data?.Members?.[0];
    if (!member) return false;

    const keyword = config.permanentAccess.membershipKeyword.toLowerCase();
    return member.MembershipStatus === 'Active' &&
           (member.MembershipTypeName || '').toLowerCase().includes(keyword);
  } catch (err) {
    log('warn', 'Permanent-access membership lookup failed — proceeding with normal PIN flow', { memberId, err: err.message });
    return false;
  }
}

// Submits a CourtReserve check-in for a member on a specific reservation —
// used by the auto check-in webhook (see processUnlockWebhookEvent). Reuses
// the existing Basic Auth courtreserve client; requires the Check-In role
// (Write permission) enabled on CR_API_KEY.
async function submitCourtReserveCheckIn(reservationId, memberId) {
  const payload = {
    ReservationId: reservationId,
    OrganizationMemberId: memberId,
  };
  if (config.checkin.statusId) payload.CheckInStatusId = config.checkin.statusId;

  const resp = await courtreserve.post('/api/v1/checkins', payload);
  if (!resp.data?.IsSuccessStatusCode) {
    throw new Error(resp.data?.ErrorMessage || 'CourtReserve check-in failed');
  }
  return resp.data.Data; // CheckInApiResultDto — IsCheckedIn, CheckedInOn, etc.
}

// ─── UniFi Access API ─────────────────────────────────────────────────────────

async function generatePin() {
  const resp = await unifi.post('/api/v1/developer/credentials/pin_codes');
  if (resp.data?.code !== 'SUCCESS') throw new Error(`PIN generation failed: ${JSON.stringify(resp.data)}`);
  return resp.data.data;
}

// Marks visitors CourtPin creates so cleanupExpiredVisitors' orphan pass can
// tell them apart from visitors created by staff or other integrations —
// see CREATED_BY_MARKER usage in fetchExpiredUnifiVisitors().
const CREATED_BY_MARKER = 'Created by CourtPin';

async function createVisitor({ firstName, lastName, email, phone, startTime, endTime }) {
  const resp = await unifi.post('/api/v1/developer/visitors', {
    first_name:   firstName,
    last_name:    lastName,
    email:        email || undefined,
    mobile_phone: phone || undefined,
    start_time:   startTime,
    end_time:     endTime,
    visit_reason: 'Others',
    remarks:      CREATED_BY_MARKER,
    resources:    config.unifi.resources,
  });
  if (resp.data?.code !== 'SUCCESS') throw new Error(`Create visitor failed: ${JSON.stringify(resp.data)}`);
  return resp.data.data;
}

async function assignPin(visitorId, pin) {
  const resp = await unifi.put(`/api/v1/developer/visitors/${visitorId}/pin_codes`, { pin_code: pin });
  if (resp.data?.code !== 'SUCCESS') throw new Error(`Assign PIN failed: ${JSON.stringify(resp.data)}`);
}

async function assignPinWithFallback(visitorId, memberId) {
  // UniFi only returns a PIN hash on reads, never plaintext, so there is no
  // way to check whether a candidate PIN is already in use before attempting
  // the assignment — a collision can only be discovered by the assignment
  // itself failing. In PIN_MODE=static, retry with progressively longer
  // digit counts (see staticPinCandidates) before giving up and assigning a
  // fully random, UniFi-generated PIN as the last resort.
  if (config.pinMode !== 'static' || !memberId) {
    const pin = await generatePin();
    await assignPin(visitorId, pin);
    return pin;
  }

  for (const candidate of staticPinCandidates(memberId)) {
    try {
      await assignPin(visitorId, candidate);
      return candidate;
    } catch (err) {
      log('warn', 'Static PIN candidate rejected — trying a longer PIN', { memberId, length: candidate.length, err: err.message });
    }
  }

  const pin = await generatePin();
  await assignPin(visitorId, pin);
  log('warn', 'All static PIN candidates collided — assigned a random PIN instead', { memberId });
  return pin;
}

async function deleteVisitor(visitorId) {
  const resp = await unifi.delete(`/api/v1/developer/visitors/${visitorId}`, { params: { is_force: true } });
  if (resp.data?.code !== 'SUCCESS') {
    log('warn', 'Delete visitor non-success (may already be removed)', { visitorId, code: resp.data?.code });
  }
}

function collectDoorsFromTopology(node) {
  // UniFi nests doors differently across console/firmware versions — some return
  // a flat `doors[]` on the group, others nest doors under arbitrarily deep
  // `resource_topologies[]` (building -> floor -> room -> ...) with the door
  // itself appearing in a `resources[]` array tagged `type: "door"`. Walk both
  // shapes recursively so either format resolves to the same flat door list.
  const doors = [];
  if (Array.isArray(node.doors)) doors.push(...node.doors);
  if (Array.isArray(node.resources)) {
    doors.push(...node.resources.filter(r => r.type === 'door'));
  }
  if (Array.isArray(node.resource_topologies)) {
    for (const child of node.resource_topologies) {
      doors.push(...collectDoorsFromTopology(child));
    }
  }
  return doors;
}

async function unlockDoor(resourceId, resourceType, durationSeconds) {
  // Unlocks a door or all doors in a door group for a set duration.
  // UniFi automatically relocks to the door's normal schedule when the duration expires.
  if (resourceType === 'door_group') {
    // Fetch doors in the group and unlock each one
    try {
      const resp = await unifi.get('/api/v1/developer/door_groups/topology');
      const group = (resp.data?.data || []).find(g => g.id === resourceId);
      if (!group) { log('warn', 'Door group not found for unlock', { resourceId }); return; }
      const doors = collectDoorsFromTopology(group);
      if (doors.length === 0) { log('warn', 'No doors found in group topology', { resourceId }); }
      for (const door of doors) {
        await unifi.put(`/api/v1/developer/doors/${door.id}/unlock`, { unlock_time_limit: durationSeconds });
        log('info', 'Door unlocked', { doorId: door.id, doorName: door.name, durationSeconds });
      }
    } catch (err) {
      log('error', 'Failed to unlock door group', { resourceId, err: err.message });
    }
  } else if (resourceType === 'door') {
    try {
      await unifi.put(`/api/v1/developer/doors/${resourceId}/unlock`, { unlock_time_limit: durationSeconds });
      log('info', 'Door unlocked', { doorId: resourceId, durationSeconds });
    } catch (err) {
      log('error', 'Failed to unlock door', { resourceId, err: err.message });
    }
  }
}

async function fetchExpiredUnifiVisitors() {
  // Fetch expired-and-CourtPin-created visitors from UniFi. This catches
  // orphaned visitors that CourtPin lost track of due to a state file reset
  // (e.g. Railway restarting and clearing /tmp/state.json). Scoped to the
  // CREATED_BY_MARKER remarks tag so this orphan sweep never deletes visitors
  // created by staff or another integration — only ones CourtPin made itself.
  try {
    const resp = await unifi.get('/api/v1/developer/visitors', {
      params: { page_num: 1, page_size: 200 },
    });
    if (resp.data?.code !== 'SUCCESS') return [];
    const nowSec = Math.floor(Date.now() / 1000);
    return (resp.data.data || []).filter(v =>
      v.end_time && v.end_time < nowSec && v.remarks === CREATED_BY_MARKER
    );
  } catch (err) {
    log('warn', 'Could not fetch visitor list from UniFi', { err: err.message });
    return [];
  }
}

// ─── Core Processing ──────────────────────────────────────────────────────────

async function processReservation(reservation, state) {
  const reservationId = String(reservation.Id);
  const startDate     = new Date(reservation.StartTime);
  const endDate       = new Date(reservation.EndTime);
  const courts        = reservation.Courts || '';
  const players       = reservation.Players || [];

  if (!reservationId || isNaN(startDate) || isNaN(endDate)) {
    log('warn', 'Skipping reservation with invalid fields', { reservationId });
    return;
  }

  const nowMs             = Date.now();
  const minutesUntilStart = (startDate.getTime() - nowMs) / 60_000;

  log('debug', 'Reservation timing check', {
    reservationId,
    startDate:         startDate.toString(),
    minutesUntilStart: Math.round(minutesUntilStart),
    notifyWindow:      config.notifyMinutesBefore,
  });

  // Process if within the notification window and not yet started (5 min grace period)
  if (minutesUntilStart > config.notifyMinutesBefore || minutesUntilStart < -5) return;

  // Visitor access starts ACCESS_BUFFER_MINUTES before the reservation
  const accessBufferSecs = config.accessBufferMinutes * 60;
  const startEpoch       = toEpoch(startDate) - accessBufferSecs;
  const endEpoch         = toEpoch(endDate);

  // Uncomment to debug player data returned from CourtReserve:
  // log('debug', 'Reservation players found', {
  //   reservationId,
  //   playerCount: players.length,
  //   players: players.map(p => ({
  //     memberId: p.OrganizationMemberId,
  //     name:     `${p.FirstName || ''} ${p.LastName || ''}`.trim(),
  //     hasEmail: !!p.Email,
  //     hasPhone: !!p.Phone,
  //   })),
  // });

  for (const player of players) {
    const { OrganizationMemberId: memberId, FirstName, LastName, Email: email, Phone: phone } = player;
    const playerKey = `${reservationId}:${memberId}`;

    if (state.processed[playerKey]) {
      log('debug', 'Skipping already processed player', { playerKey });
      continue;
    }

    if (!email) {
      log('warn', 'Player has no email — skipping', { reservationId, memberId });
      continue;
    }

    const memberName = `${FirstName || ''} ${LastName || ''}`.trim() || 'Member';
    log('info', 'Processing player', { reservationId, memberId, minutesUntilStart: Math.round(minutesUntilStart) });

    // Member already has a permanent 24/7 UniFi credential (see config.permanentAccess) —
    // skip creating a second, temporary PIN that would just collide with their existing one.
    // Their permanent PIN is assumed to be the same PIN_MODE=static derivation CourtPin
    // would otherwise assign, so it's reused directly rather than stored separately.
    if (await hasPermanentAccess(memberId)) {
      const pin = deriveStaticPin(memberId);
      try {
        await sendAccessEmail({ to: email, memberName, pin, startDate, endDate, courts, accessBufferMinutes: config.accessBufferMinutes });
      } catch (err) {
        log('error', 'Failed to send email to permanent-access member', { email, err: err.message });
      }
      if (config.twilio.enabled && phone) {
        try {
          await sendAccessSms({ to: phone, memberName, pin, startDate, courts, accessBufferMinutes: config.accessBufferMinutes });
        } catch (err) {
          log('error', 'Failed to send SMS to permanent-access member', { phone, err: err.message });
        }
      }
      state.processed[playerKey] = {
        memberId,
        reservationId: reservation.Id,
        email,
        pin,
        memberName,
        phone:       phone || '',
        court:       courts,
        startEpoch:  toEpoch(startDate),
        endEpoch,
        processedAt: Math.floor(nowMs / 1000),
        permanentAccess: true, // no UniFi visitor created — member already has standing access
      };
      saveState(state);
      log('info', '✅ Permanent-access member — reused existing PIN, no visitor created', { reservationId, memberId, pin });
      continue;
    }

    // 1. Create UniFi Visitor
    let visitor;
    try {
      visitor = await createVisitor({
        firstName: FirstName || 'Guest',
        lastName:  LastName  || '',
        email,
        phone:     phone || '',
        startTime: startEpoch,
        endTime:   endEpoch,
      });
    } catch (err) {
      log('error', 'Failed to create UniFi visitor', { memberId, err: err.message });
      continue;
    }

    // 2. Generate and assign PIN
    // PIN_MODE=random (default) — new random PIN each reservation via UniFi API
    // PIN_MODE=static           — uses CourtReserve OrganizationMemberId as PIN,
    //                             falling back to a longer/random PIN on collision
    //                             (see assignPinWithFallback)
    //                             falls back to random if member ID is missing
    let pin;
    try {
      if (config.pinMode === 'static' && !memberId) {
        log('warn', 'Static PIN mode set but member ID missing — falling back to random PIN', { reservationId });
      }
      pin = await assignPinWithFallback(visitor.id, memberId);
    } catch (err) {
      log('error', 'Failed to generate/assign PIN', { visitorId: visitor.id, err: err.message });
      await deleteVisitor(visitor.id).catch(() => {});
      continue;
    }

    // 3. Send email
    try {
      await sendAccessEmail({ to: email, memberName, pin, startDate, endDate, courts, accessBufferMinutes: config.accessBufferMinutes });
    } catch (err) {
      log('error', 'Failed to send email', { email, err: err.message });
    }

    // 4. Send SMS (optional)
    if (config.twilio.enabled && phone) {
      try {
        await sendAccessSms({ to: phone, memberName, pin, startDate, courts, accessBufferMinutes: config.accessBufferMinutes });
      } catch (err) {
        log('error', 'Failed to send SMS', { phone, err: err.message });
      }
    }

    // 5. Persist state with all details for admin portal
    state.processed[playerKey] = {
      visitorId:   visitor.id,
      memberId,
      reservationId: reservation.Id, // needed for POST /api/v1/checkins (auto check-in webhook)
      email,
      pin,
      memberName,
      phone:       phone  || '',
      court:       courts,
      startEpoch:  toEpoch(startDate),
      endEpoch,
      processedAt: Math.floor(nowMs / 1000),
    };
    saveState(state);

    log('info', '✅ Player processed successfully', {
      reservationId,
      memberId,
      visitorId:        visitor.id,
      email,
      pin,
      court:            courts,
      reservationStart: startDate.toLocaleString(),
    });
  }
}

// Guest/public-booking registrants come back from CourtReserve with
// OrganizationMemberId: 0 (not null) — every guest on the same event session
// would otherwise collide on the same identifier. PublicBookingId is unique
// per registration and confirmed present on every guest row in production, so
// it stands in for the member ID rather than falling back to email.
function registrantKey(reg) {
  return reg.OrganizationMemberId || reg.PublicBookingId;
}

async function processEvents(registrations, state) {
  // Group registrations by eventId:eventDateId so we handle each event session once
  const eventMap = new Map();
  for (const reg of registrations) {
    const eventKey = `${reg.EventId}:${reg.EventDateId || 0}`;
    if (!eventMap.has(eventKey)) eventMap.set(eventKey, []);
    eventMap.get(eventKey).push(reg);
  }

  for (const [eventKey, regs] of eventMap) {
    const first      = regs[0];
    const startDate  = new Date(first.StartTime);
    const endDate    = new Date(first.EndTime);
    const eventName  = first.EventName || 'Event';
    const nowMs      = Date.now();
    const minutesUntilStart = (startDate.getTime() - nowMs) / 60_000;
    const bufferMins = config.events.accessBufferMinutes;

    // For events, allow processing until the event ends (not just 5 min after start).
    // This ensures late registrants who sign up after an event begins still get access.
    const endEpoch   = toEpoch(endDate);
    const minutesUntilEnd = (endDate.getTime() - nowMs) / 60_000;
    if (minutesUntilStart > config.notifyMinutesBefore || minutesUntilEnd < 0) continue;

    const startEpoch = toEpoch(startDate) - (bufferMins * 60);
    const mode       = config.events.accessMode;

    log('info', `Processing event [${mode}]`, { eventKey, eventName, registrantCount: regs.length, minutesUntilStart: Math.round(minutesUntilStart) });

    // ── pin_individual: one visitor + PIN per registrant ──────────────────
    // One visitor/PIN per registrant means (unlike pin_shared/unlock) the
    // PIN-unlock webhook's visitor UUID unambiguously identifies who entered,
    // so these entries also carry a reservationId to support auto check-in
    // (see fetchEventReservationId / processUnlockWebhookEvent).
    if (mode === 'pin_individual') {
      let reservationId;
      let reservationIdFetched = false;

      for (const reg of regs) {
        const key = registrantKey(reg);
        if (!key) { log('warn', 'Event registrant has no OrganizationMemberId or PublicBookingId — skipping', { eventKey, email: reg.Email }); continue; }

        const stateKey   = `evt:${reg.EventId}:${reg.EventDateId || 0}:${key}`;
        if (state.processed[stateKey]) continue;

        const memberId   = reg.OrganizationMemberId;
        const memberName = `${reg.FirstName || ''} ${reg.LastName || ''}`.trim() || 'Member';
        const email      = reg.Email;
        const phone      = reg.Phone || '';

        if (!email) { log('warn', 'Event registrant has no email — skipping', { stateKey }); continue; }

        // Resolved once per session, on first new registrant seen this cycle —
        // not fatal if it fails, the registrant still gets their PIN, they just
        // won't be eligible for PIN-unlock auto check-in this session.
        if (!reservationIdFetched) {
          try {
            reservationId = await fetchEventReservationId(reg.EventId, startDate, endDate);
          } catch (err) {
            log('warn', 'Failed to resolve event reservationId — auto check-in unavailable for this session', { eventKey, err: err.message });
            reservationId = null;
          }
          reservationIdFetched = true;
        }

        // Member already has a permanent 24/7 UniFi credential — see the same
        // check/comment in processReservation.
        if (await hasPermanentAccess(memberId)) {
          const pin = deriveStaticPin(memberId);
          try { await sendAccessEmail({ to: email, memberName, pin, startDate, endDate, courts: eventName, accessBufferMinutes: bufferMins, courtLabel: 'Event' }); }
          catch (err) { log('error', 'Failed to send event email to permanent-access member', { email, err: err.message }); }

          if (config.twilio.enabled && phone) {
            try { await sendAccessSms({ to: phone, memberName, pin, startDate, courts: eventName, accessBufferMinutes: bufferMins }); }
            catch (err) { log('error', 'Failed to send event SMS to permanent-access member', { phone, err: err.message }); }
          }

          state.processed[stateKey] = { memberId, reservationId, email, pin, memberName, phone, court: eventName, startEpoch: toEpoch(startDate), endEpoch, processedAt: Math.floor(nowMs / 1000), type: 'event', permanentAccess: true };
          saveState(state);
          log('info', '✅ Permanent-access event registrant — reused existing PIN, no visitor created', { stateKey, pin });
          continue;
        }

        let visitor;
        try {
          visitor = await createVisitor({ firstName: reg.FirstName || 'Guest', lastName: reg.LastName || '', email, phone, startTime: startEpoch, endTime: endEpoch });
        } catch (err) { log('error', 'Failed to create visitor for event registrant', { stateKey, err: err.message }); continue; }

        let pin;
        try {
          pin = await assignPinWithFallback(visitor.id, memberId);
        } catch (err) {
          log('error', 'Failed to assign PIN for event registrant', { stateKey, err: err.message });
          await deleteVisitor(visitor.id).catch(() => {});
          continue;
        }

        try { await sendAccessEmail({ to: email, memberName, pin, startDate, endDate, courts: eventName, accessBufferMinutes: bufferMins, courtLabel: 'Event' }); }
        catch (err) { log('error', 'Failed to send event email', { email, err: err.message }); }

        if (config.twilio.enabled && phone) {
          try { await sendAccessSms({ to: phone, memberName, pin, startDate, courts: eventName, accessBufferMinutes: bufferMins }); }
          catch (err) { log('error', 'Failed to send event SMS', { phone, err: err.message }); }
        }

        state.processed[stateKey] = { visitorId: visitor.id, memberId, reservationId, email, pin, memberName, phone, court: eventName, startEpoch: toEpoch(startDate), endEpoch, processedAt: Math.floor(nowMs / 1000), type: 'event' };
        saveState(state);
        log('info', '✅ Event registrant processed (individual)', { stateKey, email, pin, reservationId });
      }
    }

    // ── pin_shared: one visitor + PIN for the whole event ─────────────────
    // The visitor and PIN are created once. Per-registrant notifications are
    // tracked separately so new registrants always receive the PIN even after
    // the initial shared visitor has already been created.
    else if (mode === 'pin_shared') {
      const sharedKey = `evt:${eventKey}:shared`;

      // Step 1 — create the shared visitor and PIN if not yet done
      if (!state.processed[sharedKey]) {
        let visitor;
        try {
          visitor = await createVisitor({ firstName: eventName, lastName: '', email: '', phone: '', startTime: startEpoch, endTime: endEpoch });
        } catch (err) { log('error', 'Failed to create shared visitor for event', { eventKey, err: err.message }); continue; }

        let pin;
        try { pin = await generatePin(); await assignPin(visitor.id, pin); }
        catch (err) {
          log('error', 'Failed to assign shared PIN', { eventKey, err: err.message });
          await deleteVisitor(visitor.id).catch(() => {});
          continue;
        }

        state.processed[sharedKey] = { visitorId: visitor.id, pin, court: eventName, startEpoch: toEpoch(startDate), endEpoch, processedAt: Math.floor(nowMs / 1000), type: 'event_shared', notified: [] };
        saveState(state);
        log('info', '✅ Shared event visitor created', { sharedKey, pin });
      }

      // Step 2 — notify every registrant who hasn't been notified yet
      // Runs every cycle so new registrants always get the PIN
      const sharedEntry = state.processed[sharedKey];
      const notified    = new Set(sharedEntry.notified || []);
      const pin         = sharedEntry.pin;

      for (const reg of regs) {
        if (!reg.Email) continue;
        const key = registrantKey(reg);
        if (!key) { log('warn', 'Event registrant has no OrganizationMemberId or PublicBookingId — skipping', { sharedKey, email: reg.Email }); continue; }
        if (notified.has(String(key))) continue;

        const memberName = `${reg.FirstName || ''} ${reg.LastName || ''}`.trim() || 'Member';
        try { await sendAccessEmail({ to: reg.Email, memberName, pin, startDate, endDate, courts: eventName, accessBufferMinutes: bufferMins, courtLabel: 'Event' }); }
        catch (err) { log('error', 'Failed to send shared event email', { email: reg.Email, err: err.message }); continue; }

        if (config.twilio.enabled && reg.Phone) {
          try { await sendAccessSms({ to: reg.Phone, memberName, pin, startDate, courts: eventName, accessBufferMinutes: bufferMins }); }
          catch (err) { log('error', 'Failed to send shared event SMS', { phone: reg.Phone, err: err.message }); }
        }

        notified.add(String(key));
        log('info', '✅ Shared PIN sent to registrant', { sharedKey, email: reg.Email, pin });
      }

      // Persist updated notified list
      sharedEntry.notified = [...notified];
      saveState(state);
    }

    // ── unlock: unlock doors for the event duration ───────────────────────
    // The door unlock happens once. If EVENT_UNLOCK_NOTIFY=true, per-registrant
    // notifications are tracked separately so new registrants always get notified
    // even after the initial unlock has already fired.
    else if (mode === 'unlock') {
      const unlockKey = `evt:${eventKey}:unlock`;

      // Step 1 — unlock doors once
      if (!state.processed[unlockKey]) {
        const durationSecs = (endEpoch - startEpoch); // includes buffer
        for (const resource of config.unifi.resources) {
          await unlockDoor(resource.id, resource.type, durationSecs);
        }
        state.processed[unlockKey] = { court: eventName, startEpoch: toEpoch(startDate), endEpoch, processedAt: Math.floor(nowMs / 1000), type: 'event_unlock', notified: [] };
        saveState(state);
        log('info', '✅ Doors unlocked for event', { unlockKey, durationSecs });
      }

      // Step 2 — notify registrants who haven't been notified yet
      // Runs every cycle so new registrants always get the notification
      if (config.events.unlockNotify) {
        const unlockEntry = state.processed[unlockKey];
        const notified    = new Set(unlockEntry.notified || []);

        for (const reg of regs) {
          if (!reg.Email) continue;
          const key = registrantKey(reg);
          if (!key) { log('warn', 'Event registrant has no OrganizationMemberId or PublicBookingId — skipping', { unlockKey, email: reg.Email }); continue; }
          if (notified.has(String(key))) continue;

          const memberName = `${reg.FirstName || ''} ${reg.LastName || ''}`.trim() || 'Member';
          try { await sendUnlockNotificationEmail({ to: reg.Email, memberName, eventName, startDate, endDate, accessBufferMinutes: bufferMins }); }
          catch (err) { log('error', 'Failed to send unlock notification email', { email: reg.Email, err: err.message }); continue; }

          if (config.twilio.enabled && reg.Phone) {
            try { await sendUnlockNotificationSms({ to: reg.Phone, memberName, eventName, startDate, accessBufferMinutes: bufferMins }); }
            catch (err) { log('error', 'Failed to send unlock notification SMS', { phone: reg.Phone, err: err.message }); }
          }

          notified.add(String(key));
          log('info', '✅ Unlock notification sent to registrant', { unlockKey, email: reg.Email });
        }

        // Persist updated notified list
        unlockEntry.notified = [...notified];
        saveState(state);
      }
    }
  }
}

async function cleanupExpiredVisitors(state) {
  const nowSec = Math.floor(Date.now() / 1000);
  const buffer = config.cleanupBufferMinutes * 60;

  // ── Pass 1: clean up entries tracked in state.json ──────────────────────────
  for (const [key, info] of Object.entries(state.processed)) {
    if (!info.visitorId || nowSec < info.endEpoch + buffer) continue;

    log('info', 'Cleaning up expired visitor (state)', { key, visitorId: info.visitorId });
    try {
      await deleteVisitor(info.visitorId);
    } catch (err) {
      log('warn', 'Could not delete visitor', { visitorId: info.visitorId, err: err.message });
    }

    delete state.processed[key];
    saveState(state);
  }

  // ── Pass 2: clean up orphaned visitors in UniFi not in state ─────────────────
  // Handles the case where state.json was reset (Railway restart, container
  // recreation, etc.) leaving visitors in UniFi with no local record to trigger
  // cleanup via Pass 1.
  const knownVisitorIds = new Set(
    Object.values(state.processed).map(v => v.visitorId).filter(Boolean)
  );
  const expiredInUnifi = await fetchExpiredUnifiVisitors();
  for (const visitor of expiredInUnifi) {
    if (knownVisitorIds.has(visitor.id)) continue; // already handled in Pass 1
    log('info', 'Cleaning up orphaned UniFi visitor', { visitorId: visitor.id, endTime: visitor.end_time });
    try {
      await deleteVisitor(visitor.id);
    } catch (err) {
      log('warn', 'Could not delete orphaned visitor', { visitorId: visitor.id, err: err.message });
    }
  }
}

// Handles one event from the UniFi Access unlock webhook (see the
// /webhook/unifi-unlock route in the Admin Server section). Plain
// court-reservation entries and pin_individual event entries carry a
// reservationId (see processReservation / fetchEventReservationId) and are
// eligible for auto check-in. pin_shared/unlock event entries are matched
// but always skipped — those modes use one shared visitor/credential for the
// whole event, so the webhook's visitor UUID can't identify which specific
// registrant unlocked the door (see docs/auto-checkin.md).
async function processUnlockWebhookEvent(event, state) {
  if (event.credential_type !== 'PIN_CODE' || event.direction !== 'entered') {
    return { skipped: true, reason: 'not_pin_entry' };
  }

  const visitorId = event.user;
  if (!visitorId) {
    log('warn', 'Unlock webhook PIN event missing user UUID', { deviceName: event.device_name });
    return { skipped: true, reason: 'no_user_uuid' };
  }

  const match = findProcessedByVisitorId(state, visitorId);
  if (!match) {
    log('info', 'No CourtPin record found for unlock webhook visitorId', { visitorId, userName: event.user_name });
    return { skipped: true, reason: 'no_match' };
  }

  const [key, entry] = match;

  if (!entry.memberId || !entry.reservationId) {
    log('info', 'Matched entry missing memberId/reservationId — auto check-in not supported for this entry type', { key, visitorId, type: entry.type });
    return { skipped: true, reason: 'unsupported_entry_type' };
  }

  if (entry.checkedInAt) {
    log('debug', 'Already auto-checked-in — skipping duplicate webhook', { key, memberId: entry.memberId });
    return { skipped: true, reason: 'already_checked_in' };
  }

  try {
    const result = await submitCourtReserveCheckIn(entry.reservationId, entry.memberId);
    entry.checkedInAt = Math.floor(Date.now() / 1000);
    saveState(state);
    log('info', '✅ Auto check-in submitted via PIN unlock webhook', { key, memberId: entry.memberId, reservationId: entry.reservationId, isCheckedIn: result?.IsCheckedIn });
    return { skipped: false, key, memberId: entry.memberId };
  } catch (err) {
    log('error', 'Auto check-in via webhook failed', { key, memberId: entry.memberId, reservationId: entry.reservationId, err: err.message });
    return { skipped: true, reason: 'checkin_failed', error: err.message };
  }
}

let cycleInProgress = false;

async function runCycle() {
  // node-cron does not wait for a previous invocation to finish before firing
  // the next one — if a cycle runs long (e.g. a hanging SMTP connection), the
  // next minute's tick would otherwise start a second, overlapping cycle that
  // races the first to process the same reservations/events.
  if (cycleInProgress) {
    log('warn', 'Skipping cycle — previous cycle still in progress');
    return;
  }
  cycleInProgress = true;

  try {
    const state = loadState();

    // ── Reservations ────────────────────────────────────────────────────────
    let reservations = [];
    try {
      reservations = await fetchTodaysReservations();
      log('info', `Fetched ${reservations.length} reservation(s)`);
    } catch (err) {
      log('error', 'Failed to fetch reservations', { err: err.message });
    }
    for (const reservation of reservations) {
      await processReservation(reservation, state).catch(err =>
        log('error', 'Unexpected error processing reservation', { id: reservation.Id, err: err.message })
      );
    }

    // ── Events ──────────────────────────────────────────────────────────────
    let registrations = [];
    try {
      registrations = await fetchTodaysEventRegistrations();
      log('info', `Fetched ${registrations.length} event registration(s)`);
    } catch (err) {
      log('error', 'Failed to fetch event registrations', { err: err.message });
    }
    if (registrations.length) {
      await processEvents(registrations, state).catch(err =>
        log('error', 'Unexpected error processing events', { err: err.message })
      );
    }

    // ── Cleanup ─────────────────────────────────────────────────────────────
    await cleanupExpiredVisitors(state).catch(err =>
      log('error', 'Error during cleanup', { err: err.message })
    );
  } finally {
    cycleInProgress = false;
  }
}

// ─── Admin Server ─────────────────────────────────────────────────────────────

const SESSION_COOKIE = 'courtpin_session';
const sessions       = new Set();

function generateSessionId() {
  return [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
}

function isAuthenticated(req) {
  const match = (req.headers.cookie || '').match(/courtpin_session=([^;]+)/);
  return match && sessions.has(match[1]);
}

function getSessionId(req) {
  const match = (req.headers.cookie || '').match(/courtpin_session=([^;]+)/);
  return match ? match[1] : null;
}

function startAdminServer() {
  const server = http.createServer(async (req, res) => {
    const url      = new URL(req.url, `http://localhost:${config.adminPort}`);
    const send     = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'text/html', ...headers }); res.end(body); };
    const sendJson = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data, null, 2)); };

    // Health check (no auth)
    if (url.pathname === '/health') return sendJson(200, { status: 'ok', uptime: Math.floor(process.uptime()) });

    // Auto check-in webhook (no session auth — shared-secret query param instead,
    // since UniFi's Alarm Manager UI only exposes a Delivery URL, no HMAC signing)
    if (url.pathname === '/webhook/unifi-unlock' && req.method === 'POST') {
      if (!config.checkin.enabled) { send(404, '<h1>Not found</h1>'); return; }
      if (url.searchParams.get('secret') !== config.checkin.webhookSecret) {
        log('warn', 'Unlock webhook rejected — bad or missing secret');
        sendJson(401, { error: 'unauthorized' });
        return;
      }
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body || '{}');
          const events  = Array.isArray(payload.events) ? payload.events : [];
          const state   = loadState();
          const results = [];
          for (const event of events) results.push(await processUnlockWebhookEvent(event, state));
          return sendJson(200, { received: events.length, results });
        } catch (err) {
          log('error', 'Unlock webhook processing failed', { err: err.message });
          return sendJson(500, { error: err.message });
        }
      });
      return;
    }

    // Login POST
    if (url.pathname === '/admin/login' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const password = new URLSearchParams(body).get('password');
        if (password && password === config.adminSecret) {
          const sid = generateSessionId();
          sessions.add(sid);
          send(302, '', { 'Set-Cookie': `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/`, Location: '/admin' });
        } else {
          send(200, loginPage('Incorrect password. Please try again.'));
        }
      });
      return;
    }

    // Logout
    if (url.pathname === '/admin/logout') {
      const sid = getSessionId(req);
      if (sid) sessions.delete(sid);
      send(302, '', { 'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`, Location: '/admin/login' });
      return;
    }

    // Login page
    if (url.pathname === '/admin/login') return send(200, loginPage());

    // Redirect root
    if (url.pathname === '/' || url.pathname === '') return send(302, '', { Location: '/admin' });

    // All admin routes require auth
    if (!isAuthenticated(req)) return send(302, '', { Location: '/admin/login' });

    const state = loadState();

    // Resend API (called from dashboard via fetch)
    if (url.pathname === '/admin/resend' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        try {
          const { reservationId, playerId } = JSON.parse(body || '{}');
          const key   = `${reservationId}:${playerId}`;
          const entry = state.processed[key];
          if (!entry)     return sendJson(404, { error: 'Record not found.' });
          if (!entry.pin) return sendJson(409, { error: 'PIN not stored for this record.' });

          // Try to get fresh details from CourtReserve
          let memberName = entry.memberName || entry.email;
          let courts     = entry.court  || '';
          let phone      = entry.phone  || '';
          let startDate  = new Date((entry.startEpoch || entry.endEpoch - 3600) * 1000);
          let endDate    = new Date(entry.endEpoch * 1000);

          try {
            const now        = new Date();
            const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,  0,  0);
            const endOfDay   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
            const crResp     = await courtreserve.get('/api/v1/reservationreport/listactive', {
              params: { reservationsFromDate: fmtLocalDatetime(startOfDay), reservationsToDate: fmtLocalDatetime(endOfDay) },
            });
            const res = (crResp.data?.Data || []).find(r => String(r.Id) === String(reservationId));
            if (res) {
              startDate = new Date(res.StartTime);
              endDate   = new Date(res.EndTime);
              courts    = res.Courts || courts;
              const p   = (res.Players || []).find(pl => String(pl.OrganizationMemberId) === String(playerId));
              if (p) { memberName = `${p.FirstName || ''} ${p.LastName || ''}`.trim(); phone = p.Phone || phone; }
            }
          } catch (e) { log('warn', 'Could not fetch CR details for resend', { err: e.message }); }

          await sendAccessEmail({ to: entry.email, memberName, pin: entry.pin, startDate, endDate, courts, accessBufferMinutes: config.accessBufferMinutes });
          if (config.twilio.enabled && phone) {
            await sendAccessSms({ to: phone, memberName, pin: entry.pin, startDate, courts, accessBufferMinutes: config.accessBufferMinutes });
          }
          log('info', 'Admin resend', { reservationId, playerId, email: entry.email });
          return sendJson(200, { success: true, pin: entry.pin, sentTo: entry.email });
        } catch (err) {
          log('error', 'Admin resend failed', { err: err.message });
          return sendJson(500, { error: err.message });
        }
      });
      return;
    }

    // Dashboard
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      const nowSec = Math.floor(Date.now() / 1000);
      const active = Object.entries(state.processed)
        .filter(([, v]) => v.endEpoch > nowSec)
        .sort(([, a], [, b]) => a.startEpoch - b.startEpoch)
        .map(([key, v]) => {
          const parts       = key.split(':');
          const isEvent     = parts[0] === 'evt';
          // reservation key: "reservationId:memberId"
          // event key:       "evt:eventId:eventDateId:memberId"  or  "evt:eventId:eventDateId:shared"
          const reservationId = isEvent ? parts.slice(1, 3).join(':') : parts[0];
          const playerId      = isEvent ? (parts[3] || parts[2]) : parts[1];
          return {
            key,
            reservationId,
            playerId,
            email:      v.email      || '',
            pin:        v.pin        || null,
            memberName: v.memberName || (v.type === 'event_unlock' ? v.court : ''),
            phone:      v.phone      || '',
            court:      v.court      || '',
            startsAt:   v.startEpoch ? new Date(v.startEpoch * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '',
            endsAt:     new Date(v.endEpoch * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
            date:       new Date(v.endEpoch * 1000).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
            type:       v.type || 'reservation',
          };
        });
      return send(200, dashboardPage(active));
    }

    send(404, '<h1>Not found</h1>');
  });

  server.listen(config.adminPort, () => {
    log('info', `🔐 Admin portal running on port ${config.adminPort} — visit /admin`);
  });
}

// ─── Admin HTML ───────────────────────────────────────────────────────────────

function loginPage(error = '') {
  const b = config.brand;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${b.clubName} — Admin Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f0f4ff; min-height: 100vh; display: flex;
           align-items: center; justify-content: center; padding: 16px; }
    .card { background: #fff; border-radius: 14px; padding: 32px;
            width: 100%; max-width: 380px; box-shadow: 0 4px 20px rgba(0,0,0,.1); }
    .club { font-size: 22px; font-weight: 700; color: ${b.headerColor}; margin-bottom: 4px; }
    .sub  { color: #888; font-size: 14px; margin-bottom: 28px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #444; margin-bottom: 6px; }
    input { width: 100%; padding: 13px; border: 1.5px solid #ddd;
            border-radius: 8px; font-size: 16px; outline: none; }
    input:focus { border-color: ${b.headerColor}; }
    button { width: 100%; padding: 13px; background: ${b.headerColor}; color: #fff;
             border: none; border-radius: 8px; font-size: 16px;
             font-weight: 600; cursor: pointer; margin-top: 16px; }
    .error { background: #fff0f0; color: #c00; border-radius: 8px;
             padding: 10px 14px; font-size: 13px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="club">${b.clubName}</div>
    <div class="sub">Admin Portal</div>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST" action="/admin/login">
      <label>Password</label>
      <input type="password" name="password" autofocus autocomplete="current-password"/>
      <button type="submit">Log In</button>
    </form>
  </div>
</body>
</html>`;
}

function dashboardPage(active) {
  const b = config.brand;

  const cards = active.map(r => {
    const safeKey    = r.key.replace(/:/g, '_');
    const searchData = [r.memberName, r.email, r.phone, r.court, r.pin, r.reservationId].join(' ').toLowerCase();

    const isEvent   = r.type && r.type !== 'reservation';
    const isUnlock  = r.type === 'event_unlock';
    const typeLabel = r.type === 'event'        ? 'Event'
                    : r.type === 'event_shared' ? 'Event (shared PIN)'
                    : r.type === 'event_unlock' ? 'Event (door unlock)'
                    : 'Reservation';

    return `
    <div class="card" id="card-${safeKey}" data-search="${searchData}">
      <div class="card-header">
        <div>
          <div class="member-name">${r.memberName || (isUnlock ? 'Door Unlock' : '—')}</div>
          ${isEvent ? `<div class="event-badge">${typeLabel}</div>` : ''}
        </div>
        <div class="time-badge">${r.startsAt}–${r.endsAt}</div>
      </div>
      <div class="detail-grid">
        <div class="detail-item">
          <span class="detail-label">Email</span>
          <span class="detail-value">${r.email}</span>
        </div>
        ${r.phone ? `
        <div class="detail-item">
          <span class="detail-label">Phone</span>
          <span class="detail-value"><a href="tel:${r.phone}" class="phone-link">${r.phone}</a></span>
        </div>` : ''}
        <div class="detail-item">
          <span class="detail-label">${r.type && r.type !== 'reservation' ? 'Event' : 'Court'}</span>
          <span class="detail-value">${r.court || '—'}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Date</span>
          <span class="detail-value">${r.date}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">Reservation ID</span>
          <span class="detail-value id-val">${r.reservationId}</span>
        </div>
      </div>
      ${r.pin
        ? `<div class="pin-section">
             <div class="pin-label">Access PIN</div>
             <div class="pin-row">
               <div class="pin">${r.pin}</div>
               <button class="resend-btn" onclick="resend('${r.reservationId}','${r.playerId}','${safeKey}')">Resend</button>
             </div>
           </div>`
        : `<div class="no-pin">PIN not stored for this record</div>`
      }
      <div class="status" id="status-${safeKey}"></div>
    </div>`;
  }).join('');

  const emptyMsg = `<div class="empty">No active reservations right now.<br><span class="empty-sub">Processed reservations will appear here.</span></div>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${b.clubName} — Active PINs</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f0f4ff; min-height: 100vh; }
    .site-header { background: ${b.headerColor}; color: #fff; padding: 16px;
                   display: flex; justify-content: space-between; align-items: center; }
    .site-header .title { font-size: 18px; font-weight: 700; }
    .site-header .sub   { font-size: 12px; opacity: .8; margin-top: 2px; }
    .site-header a { color: rgba(255,255,255,.75); font-size: 13px; text-decoration: none; }
    .content { max-width: 480px; margin: 0 auto; padding: 16px 16px 32px; }
    .count-bar { display: flex; align-items: center; margin-bottom: 12px; }
    .count-bar .label { font-size: 14px; font-weight: 600; color: #555; }
    .badge { background: ${b.accentColor}; color: #fff; border-radius: 20px;
             padding: 2px 10px; font-size: 12px; font-weight: 700; margin-left: 8px; }
    .search-wrap { position: relative; margin-bottom: 16px; }
    .search-wrap input { width: 100%; padding: 12px 16px 12px 42px;
                         border: 1.5px solid #ddd; border-radius: 10px;
                         font-size: 16px; outline: none; background: #fff;
                         box-shadow: 0 1px 4px rgba(0,0,0,.06); }
    .search-wrap input:focus { border-color: ${b.accentColor}; }
    .search-wrap .icon { position: absolute; left: 14px; top: 50%;
                         transform: translateY(-50%); color: #bbb; pointer-events: none; }
    .no-results { text-align: center; color: #aaa; padding: 32px 0; font-size: 14px; display: none; }
    .card { background: #fff; border-radius: 14px; padding: 16px;
            margin-bottom: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.07); }
    .card-header { display: flex; justify-content: space-between;
                   align-items: flex-start; margin-bottom: 14px; }
    .member-name { font-size: 17px; font-weight: 700; color: #111; }
    .time-badge  { background: #e8f0fe; color: ${b.accentColor}; border-radius: 20px;
                   padding: 3px 10px; font-size: 12px; font-weight: 600;
                   white-space: nowrap; margin-left: 8px; flex-shrink: 0; }
    .event-badge { display: inline-block; background: #fff8e1; color: #b45309;
                   border: 1px solid #fcd34d; border-radius: 20px;
                   padding: 2px 8px; font-size: 11px; font-weight: 600;
                   margin-top: 3px; }
    .detail-grid  { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
    .detail-item  { display: flex; flex-direction: column; }
    .detail-label { font-size: 10px; color: #bbb; text-transform: uppercase;
                    letter-spacing: .5px; margin-bottom: 2px; }
    .detail-value { font-size: 13px; color: #333; font-weight: 500; word-break: break-all; }
    .id-val       { color: #bbb; font-size: 11px; }
    .phone-link   { color: ${b.accentColor}; text-decoration: none; }
    .pin-section  { border-top: 1px solid #f0f0f0; padding-top: 14px; }
    .pin-label    { font-size: 10px; color: #bbb; text-transform: uppercase;
                    letter-spacing: .5px; margin-bottom: 8px; }
    .pin-row      { display: flex; align-items: center; gap: 12px; }
    .pin          { font-size: 40px; font-weight: 800; letter-spacing: 10px;
                    color: ${b.accentColor}; flex: 1; }
    .resend-btn   { padding: 11px 20px; background: ${b.accentColor}; color: #fff;
                    border: none; border-radius: 8px; font-size: 14px;
                    font-weight: 600; cursor: pointer; white-space: nowrap; }
    .resend-btn:disabled { background: #aac0f0; cursor: default; }
    .status       { font-size: 13px; margin-top: 10px; min-height: 18px; }
    .status.ok    { color: #1a7f37; }
    .status.err   { color: #c00; }
    .no-pin       { font-size: 13px; color: #aaa; font-style: italic;
                    border-top: 1px solid #f0f0f0; padding-top: 12px; }
    .empty        { text-align: center; color: #999; padding: 48px 0; line-height: 2; }
    .empty-sub    { font-size: 13px; color: #bbb; }
  </style>
</head>
<body>
  <div class="site-header">
    <div>
      <div class="title">${b.clubName}</div>
      <div class="sub">Admin Portal</div>
    </div>
    <a href="/admin/logout">Log out</a>
  </div>

  <div class="content">
    <div class="count-bar">
      <span class="label">Active Reservations</span>
      <span class="badge" id="count-badge">${active.length}</span>
    </div>
    <div class="search-wrap">
      <span class="icon">🔍</span>
      <input type="search" id="search" placeholder="Search name, email, court, PIN…"
             oninput="filterCards()" autocomplete="off" autocorrect="off" spellcheck="false"/>
    </div>
    <div id="cards-container">
      ${active.length === 0 ? emptyMsg : cards}
    </div>
    <div class="no-results" id="no-results">No results match your search.</div>
  </div>

  <script>
    function filterCards() {
      const q       = document.getElementById('search').value.toLowerCase().trim();
      const cards   = document.querySelectorAll('.card');
      let   visible = 0;
      cards.forEach(card => {
        const show = !q || card.dataset.search.includes(q);
        card.style.display = show ? '' : 'none';
        if (show) visible++;
      });
      document.getElementById('count-badge').textContent = visible;
      document.getElementById('no-results').style.display = (visible === 0 && q) ? 'block' : 'none';
    }

    async function resend(reservationId, playerId, key) {
      const btn    = document.querySelector('#card-' + key + ' .resend-btn');
      const status = document.getElementById('status-' + key);
      btn.disabled    = true;
      btn.textContent = 'Sending…';
      status.className   = 'status';
      status.textContent = '';
      try {
        const resp = await fetch('/admin/resend', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ reservationId, playerId }),
        });
        const data = await resp.json();
        if (data.success) {
          status.className   = 'status ok';
          status.textContent = '✅ Resent to ' + data.sentTo;
        } else {
          throw new Error(data.error || 'Unknown error');
        }
      } catch (err) {
        status.className   = 'status err';
        status.textContent = '❌ ' + err.message;
      }
      btn.disabled    = false;
      btn.textContent = 'Resend';
    }
  </script>
</body>
</html>`;
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

function validateConfig() {
  const required = [
    ['CR_ORG_ID',       config.courtreserve.orgId],
    ['CR_API_KEY',      config.courtreserve.apiKey],
    ['UNIFI_HOST',      config.unifi.host],
    ['UNIFI_API_TOKEN', config.unifi.token],
    ['EMAIL_FROM',      config.email.from],
    ['ADMIN_SECRET',    config.adminSecret],
  ];
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`❌  Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Email transport validation
  if (config.email.resendApiKey) {
    log('info', '📧 Email transport: Resend');
  } else if (config.email.smtp.host && config.email.smtp.user) {
    log('info', '📧 Email transport: SMTP', { host: config.email.smtp.host, port: config.email.smtp.port });
  } else {
    console.error('❌  No email transport configured. Set either RESEND_API_KEY (for Resend) or SMTP_HOST + SMTP_USER + SMTP_PASS (for SMTP).');
    process.exit(1);
  }
  if (!config.unifi.resources.length) {
    console.warn('⚠️   UNIFI_RESOURCES is not set — visitors will have no door access assigned and unlock mode will have no effect.');
  }
  const validModes = ['pin_individual', 'pin_shared', 'unlock'];
  if (!validModes.includes(config.events.accessMode)) {
    console.error(`❌  Invalid EVENT_ACCESS_MODE "${config.events.accessMode}". Must be one of: ${validModes.join(', ')}`);
    process.exit(1);
  }

  if (config.checkin.enabled && !config.checkin.webhookSecret) {
    console.error('❌  AUTO_CHECKIN_ENABLED=true but CHECKIN_WEBHOOK_SECRET is not set.');
    process.exit(1);
  }

  if (config.permanentAccess.membershipKeyword && config.pinMode !== 'static') {
    console.warn('⚠️   PERMANENT_ACCESS_MEMBERSHIP_KEYWORD is set but PIN_MODE is not "static" — the reused PIN this feature relies on only reflects a real credential in static mode, so it will be ignored.');
  }
}

async function main() {
  validateConfig();
  log('info', '🚀 CourtReserve ↔ UniFi Access integration starting', {
    clubName:             config.brand.clubName,
    notifyMinutesBefore:  config.notifyMinutesBefore,
    accessBufferMinutes:  config.accessBufferMinutes,
    cleanupBufferMinutes: config.cleanupBufferMinutes,
    emailTransport:       config.email.resendApiKey ? 'resend' : 'smtp',
    pinMode:              config.pinMode,
    staticPinLength:      config.pinMode === 'static' ? config.staticPinLength : 'n/a',
    smsEnabled:           config.twilio.enabled,
    eventAccessMode:      config.events.accessMode,
    eventBufferMinutes:   config.events.accessBufferMinutes,
    eventUnlockNotify:    config.events.unlockNotify,
    resources:            config.unifi.resources,
    checkinEnabled:       config.checkin.enabled,
  });

  startAdminServer();
  await runCycle();
  cron.schedule('* * * * *', runCycle);
  log('info', '⏱  Scheduler running — checking every minute.');
}

main();
