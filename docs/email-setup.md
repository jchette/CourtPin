# Email Setup

CourtPin supports two email delivery methods. Choose one based on how you are hosting.

| Hosting method | Recommended transport | Why |
|---|---|---|
| Railway | Resend | Railway blocks outbound SMTP ports |
| Raspberry Pi / local | SMTP | No port restrictions, use existing email host |
| Docker / NAS | SMTP | Same as local — no restrictions |
| VPS | Either | Both work on a VPS |

---

## Option A — Resend

[Resend](https://resend.com) sends email over HTTPS (port 443) which is never blocked on cloud platforms. The free tier includes 3,000 emails per month and 100 per day — more than enough for most clubs.

### Setup

1. Go to [resend.com](https://resend.com) and create a free account

2. Go to **Domains → Add Domain** and enter your club's domain (e.g. `yourclub.com`)

3. Resend shows DNS records to add. Log into your DNS provider and add each one:
   - **Bluehost:** Domains → DNS → Zone Editor → Add Record
   - **GoDaddy:** DNS → Add
   - **Cloudflare:** DNS → Add Record
   - **Google Domains / Squarespace:** DNS → Custom records

4. Back in Resend click **Verify DNS Records**. This usually takes 1–5 minutes. If it fails, wait a few minutes and try again — DNS propagation can take time.

5. Once your domain shows **Verified**, go to **API Keys → Create API Key**

6. Name it `CourtPin`, set permission to **Sending access**, click Create

7. Copy the key immediately — it is only shown once

8. Set these environment variables:
   ```
   RESEND_API_KEY=re_your_key_here
   EMAIL_FROM=noreply@yourclub.com
   ```

### Testing before your domain is verified

Resend provides a shared test sender you can use immediately without domain verification:
```
EMAIL_FROM=onboarding@resend.dev
```

Emails from this address may land in spam. It is fine for confirming the integration works — switch to your real address once your domain is verified.

---

## Option B — SMTP

SMTP works with any standard email provider. On a local machine (Pi, NAS, Windows) there are no port restrictions so you can use whatever you already have.

### Using your existing email host

Most hosting providers (Bluehost, SiteGround, DreamHost, etc.) include email hosting. Check your hosting control panel for SMTP settings — usually found under **Email → Email Accounts → Connect Devices** or similar.

Common settings by provider:

| Provider | `SMTP_HOST` | `SMTP_PORT` | `SMTP_SECURE` |
|---|---|---|---|
| Bluehost / cPanel | `mail.yourdomain.com` | `465` | `true` |
| SiteGround | `mail.yourdomain.com` | `465` | `true` |
| Gmail | `smtp.gmail.com` | `587` | `false` |
| Google Workspace | `smtp.gmail.com` | `587` | `false` |
| Microsoft 365 / Outlook | `smtp.office365.com` | `587` | `false` |
| Zoho Mail | `smtp.zoho.com` | `587` | `false` |
| FastMail | `smtp.fastmail.com` | `587` | `false` |

Set these environment variables:
```
SMTP_HOST=mail.yourdomain.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=noreply@yourclub.com
SMTP_PASS=your_email_password
EMAIL_FROM=noreply@yourclub.com
```

### Using Gmail

Gmail requires an **App Password** — your regular Google account password will not work for SMTP.

1. Go to [myaccount.google.com](https://myaccount.google.com) → **Security**
2. Under "How you sign in to Google", ensure **2-Step Verification** is on
3. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
4. Enter a name like `CourtPin` and click **Create**
5. Copy the 16-character password (shown without spaces)

Set these environment variables:
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=youremail@gmail.com
SMTP_PASS=abcdefghijklmnop
EMAIL_FROM=youremail@gmail.com
```

### Running a local SMTP server (fully self-hosted)

If you want zero external email dependency, you can run an SMTP server on the same machine or network as CourtPin.

#### Mailhog — for testing only

Mailhog catches emails locally and shows them in a web UI. It does not actually deliver mail to real inboxes — perfect for development and testing.

```bash
# Install on Linux / Raspberry Pi
wget https://github.com/mailhog/MailHog/releases/latest/download/MailHog_linux_amd64
chmod +x MailHog_linux_amd64
sudo mv MailHog_linux_amd64 /usr/local/bin/mailhog
mailhog &

# Or via Docker:
docker run -d -p 1025:1025 -p 8025:8025 mailhog/mailhog
```

- Web UI (view sent emails): `http://localhost:8025`
- SMTP: `localhost:1025`

```
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
EMAIL_FROM=noreply@yourclub.com
```

#### Postfix — for real email delivery

Postfix is the standard Linux mail transfer agent. It delivers real email directly to recipients.

```bash
sudo apt install postfix
# Choose "Internet Site" during setup
# Enter your domain name when prompted (e.g. yourclub.com)
```

```
SMTP_HOST=localhost
SMTP_PORT=25
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
EMAIL_FROM=noreply@yourclub.com
```

> **Important:** Delivering email directly from a self-hosted server often results in messages landing in spam unless you configure SPF, DKIM, and DMARC DNS records for your domain. For most clubs, using your existing email hosting via SMTP is simpler and more reliable than running a full mail server.

---

## What the email looks like

Members receive an HTML email containing:

- Club name and tagline in the header (styled in your brand colors)
- Member's first name in the greeting
- PIN in large digits in a highlighted box
- "Active from" time — when they can start using the PIN
- Court name, start time, and end time
- A notice explaining when the PIN expires
- Club contact info in the footer (phone, website, address if configured)

**Subject line format:**
```
Your Club Name Access PIN - Mon Mar 16, 12:00 PM
```

---

## What the SMS looks like

If Twilio is enabled, members also receive:

```
Your Club Name — Your Door Access PIN

PIN: 67203419
Court: Court 1
Reservation: Mar 15, 12:00 PM

Enter this PIN at the front door keypad. Your PIN is active 30 minutes before your reservation starts and expires when your reservation ends.

Do not share this PIN.
```

> The SMS is written to stand completely on its own — a member who did not read their email should still understand exactly what to do when they arrive at the door. The club name is pulled dynamically from `BRAND_CLUB_NAME`.

Phone numbers from CourtReserve are automatically formatted to E.164 (`3045550100` → `+13045550100`).

---

## Setting up Twilio for SMS

1. Go to [twilio.com](https://twilio.com) and create an account
2. Verify your email and phone number
3. From [console.twilio.com](https://console.twilio.com) copy your **Account SID** and **Auth Token**
4. Go to **Phone Numbers → Manage → Buy a Number** (~$1/month)
5. Copy the number in E.164 format (e.g. `+13045550100`)
6. Set:
   ```
   TWILIO_ENABLED=true
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_AUTH_TOKEN=your_token
   TWILIO_FROM_NUMBER=+15550000000
   ```

> **Free trial note:** Twilio's free trial only sends SMS to verified phone numbers. To send to any number, add a credit card to your account — you are not charged until you exceed the $15 trial credit (~1,900 texts).
