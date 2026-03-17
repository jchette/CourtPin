/**
 * CourtReserve <-> UniFi Access Integration
 *
 * Flow:
 *  1. Poll CourtReserve every minute for today's active reservations.
 *  2. For each reservation within the notification window (not yet processed):
 *     a. Create a Visitor in UniFi Access with a time window that starts
 *        ACCESS_BUFFER_MINUTES before the reservation.
 *     b. Generate a random PIN via the UniFi Credential API.
 *     c. Assign the PIN to the Visitor.
 *     d. Email the member their PIN via Resend.
 *     e. Optionally SMS the member via Twilio.
 *  3. After the reservation ends + cleanup buffer, delete the Visitor.
 *  4. Serve a mobile-friendly admin portal for PIN lookup and resend.
 *
 * Required CourtReserve API role : ReservationReport (Read)
 * Required UniFi Access scopes   : view:credential, edit:visitor
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

async function sendAccessEmail({ to, memberName, pin, startDate, endDate, courts, accessBufferMinutes }) {
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

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <style>
    body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 40px auto; background: #fff; border-radius: 8px;
                 overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.1); }
    .header { background: ${b.headerColor}; color: #fff; padding: 28px 32px; text-align: center; }
    .header h1 { margin: 0; font-size: 24px; font-weight: 700; }
    .header .tagline { margin: 6px 0 0; font-size: 13px; opacity: .85; }
    .body { padding: 32px; color: #333; }
    .pin-box { background: #f5f7ff; border: 2px dashed ${b.accentColor};
               border-radius: 10px; text-align: center; margin: 24px 0; padding: 24px; }
    .pin-box .pin    { font-size: 52px; font-weight: bold; letter-spacing: 14px; color: ${b.accentColor}; }
    .pin-box .label  { font-size: 13px; color: #666; margin-top: 6px; }
    .pin-box .active { font-size: 13px; color: ${b.accentColor}; font-weight: 600; margin-top: 6px; }
    .details { background: #f9f9f9; border-radius: 8px; padding: 16px; margin-top: 16px;
               border-left: 4px solid ${b.accentColor}; }
    .details p { margin: 6px 0; font-size: 14px; }
    .notice { margin-top: 24px; font-size: 13px; color: #777; line-height: 1.6;
              background: #fffbf0; border-radius: 6px; padding: 12px 16px;
              border: 1px solid #ffe8a0; }
    .footer { text-align: center; font-size: 12px; color: #aaa; padding: 20px 16px;
              border-top: 1px solid #f0f0f0; line-height: 1.8; }
    .footer strong { color: #888; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${b.clubName}</h1>
      ${b.tagline ? `<p class="tagline">${b.tagline}</p>` : ''}
    </div>
    <div class="body">
      <p style="font-size:16px;">Hi <strong>${memberName}</strong>,</p>
      <p style="margin-top:8px; color:#555;">Your reservation is coming up! Use the PIN below to access the building.</p>
      <div class="pin-box">
        <div class="pin">${pin}</div>
        <div class="label">Enter this PIN at the front door keypad</div>
        <div class="active">Active from ${accessStr}</div>
      </div>
      <div class="details">
        <p>🎾 <strong>Court:</strong> ${courtStr}</p>
        <p>🕐 <strong>Start:</strong> ${startStr}</p>
        <p>🕑 <strong>End:</strong>   ${endStr}</p>
      </div>
      <div class="notice">
        ⏰ Your PIN becomes active <strong>${accessBufferMinutes} minutes before</strong> your
        reservation at <strong>${accessStr}</strong> and expires when your session ends.
        Please do not share your PIN. Contact the front desk with any questions.
      </div>
    </div>
    <div class="footer">
      <strong>${b.clubName}</strong><br/>
      ${contactLines ? `${contactLines}<br/>` : ''}
      This is an automated message — please do not reply to this email.
    </div>
  </div>
</body>
</html>`;

  const subject = `${b.clubName} Access PIN - ${startStr}`;

  if (config.email.resendApiKey) {
    // ── Resend (recommended for cloud hosting like Railway) ──────────────────
    const resp = await axios.post(
      'https://api.resend.com/emails',
      { from: config.email.from, to: [to], subject, html },
      { headers: { Authorization: `Bearer ${config.email.resendApiKey}`, 'Content-Type': 'application/json' }, timeout: 10_000 }
    );
    if (resp.data?.id) {
      log('info', 'Email sent via Resend', { to, id: resp.data.id });
    } else {
      throw new Error(`Resend unexpected response: ${JSON.stringify(resp.data)}`);
    }
  } else {
    // ── SMTP via nodemailer (recommended for local / self-hosted setups) ─────
    const transporter = nodemailer.createTransport({
      host:   config.email.smtp.host,
      port:   config.email.smtp.port,
      secure: config.email.smtp.secure,
      auth: {
        user: config.email.smtp.user,
        pass: config.email.smtp.pass,
      },
    });
    await transporter.sendMail({
      from:    config.email.from,
      to,
      subject,
      html,
    });
    log('info', 'Email sent via SMTP', { to, host: config.email.smtp.host });
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

// ─── UniFi Access API ─────────────────────────────────────────────────────────

async function generatePin() {
  const resp = await unifi.post('/api/v1/developer/credentials/pin_codes');
  if (resp.data?.code !== 'SUCCESS') throw new Error(`PIN generation failed: ${JSON.stringify(resp.data)}`);
  return resp.data.data;
}

async function createVisitor({ firstName, lastName, email, phone, startTime, endTime }) {
  const resp = await unifi.post('/api/v1/developer/visitors', {
    first_name:   firstName,
    last_name:    lastName,
    email:        email || undefined,
    mobile_phone: phone || undefined,
    start_time:   startTime,
    end_time:     endTime,
    visit_reason: 'Others',
    resources:    config.unifi.resources,
  });
  if (resp.data?.code !== 'SUCCESS') throw new Error(`Create visitor failed: ${JSON.stringify(resp.data)}`);
  return resp.data.data;
}

async function assignPin(visitorId, pin) {
  const resp = await unifi.put(`/api/v1/developer/visitors/${visitorId}/pin_codes`, { pin_code: pin });
  if (resp.data?.code !== 'SUCCESS') throw new Error(`Assign PIN failed: ${JSON.stringify(resp.data)}`);
}

async function deleteVisitor(visitorId) {
  const resp = await unifi.delete(`/api/v1/developer/visitors/${visitorId}`, { params: { is_force: true } });
  if (resp.data?.code !== 'SUCCESS') {
    log('warn', 'Delete visitor non-success (may already be removed)', { visitorId, code: resp.data?.code });
  }
}

async function fetchExpiredUnifiVisitors() {
  // Fetch all visitors from UniFi whose end_time has already passed.
  // This catches orphaned visitors that CourtPin lost track of due to
  // a state file reset (e.g. Railway restarting and clearing /tmp/state.json).
  try {
    const resp = await unifi.get('/api/v1/developer/visitors', {
      params: { page_num: 1, page_size: 200 },
    });
    if (resp.data?.code !== 'SUCCESS') return [];
    const nowSec = Math.floor(Date.now() / 1000);
    return (resp.data.data || []).filter(v => v.end_time && v.end_time < nowSec);
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
    let pin;
    try {
      pin = await generatePin();
      await assignPin(visitor.id, pin);
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

async function runCycle() {
  const state = loadState();

  let reservations = [];
  try {
    reservations = await fetchTodaysReservations();
    log('info', `Fetched ${reservations.length} reservation(s)`);
  } catch (err) {
    log('error', 'Failed to fetch reservations', { err: err.message });
    return;
  }

  for (const reservation of reservations) {
    await processReservation(reservation, state).catch(err =>
      log('error', 'Unexpected error processing reservation', { id: reservation.Id, err: err.message })
    );
  }

  await cleanupExpiredVisitors(state).catch(err =>
    log('error', 'Error during cleanup', { err: err.message })
  );
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
        .map(([key, v]) => ({
          key,
          reservationId: key.split(':')[0],
          playerId:      key.split(':')[1],
          email:         v.email,
          pin:           v.pin        || null,
          memberName:    v.memberName || '',
          phone:         v.phone      || '',
          court:         v.court      || '',
          startsAt:      v.startEpoch ? new Date(v.startEpoch * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '',
          endsAt:        new Date(v.endEpoch * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
          date:          new Date(v.endEpoch * 1000).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
        }));
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

    return `
    <div class="card" id="card-${safeKey}" data-search="${searchData}">
      <div class="card-header">
        <div class="member-name">${r.memberName || '—'}</div>
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
          <span class="detail-label">Court</span>
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
    console.warn('⚠️   UNIFI_RESOURCES is not set — visitors will have no door access assigned.');
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
    smsEnabled:           config.twilio.enabled,
    resources:            config.unifi.resources,
  });

  startAdminServer();
  await runCycle();
  cron.schedule('* * * * *', runCycle);
  log('info', '⏱  Scheduler running — checking every minute.');
}

main();
