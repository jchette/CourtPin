# CourtPass

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)
![Platform: Railway](https://img.shields.io/badge/Deploy-Railway-blueviolet.svg)

**Automated building access for court sports clubs.**

CourtPass connects [CourtReserve](https://courtreserve.com) with [UniFi Access](https://ui.com/door-access) to automatically send members a door PIN before their reservation — no staff involvement required. When a member books a court, CourtPass creates a time-limited visitor in UniFi Access, generates a unique PIN, and delivers it by email and optional SMS. After the reservation ends, access is automatically revoked.

Built for tennis, pickleball, squash, and racquetball clubs running CourtReserve for reservations and UniFi Access for door control.

---

## Table of Contents

1. [How it works](#how-it-works)
2. [Example timeline](#example-timeline)
3. [Requirements](#requirements)
4. [Services you will need to set up](#services-you-will-need-to-set-up)
5. [Installation and hosting options](#installation-and-hosting-options)
6. [Option 1 — Railway (recommended for most clubs)](#option-1--railway-recommended-for-most-clubs)
7. [Option 2 — Raspberry Pi or local Linux machine](#option-2--raspberry-pi-or-local-linux-machine)
8. [Option 3 — Docker](#option-3--docker)
9. [Option 4 — Synology or QNAP NAS](#option-4--synology-or-qnap-nas)
10. [Option 5 — VPS (DigitalOcean, Hetzner, Vultr)](#option-5--vps-digitalocean-hetzner-vultr)
11. [Option 6 — Windows PC](#option-6--windows-pc)
12. [Making your UniFi console reachable](#making-your-unifi-console-reachable)
13. [All environment variables](#all-environment-variables)
14. [Railway raw editor — copy and paste](#railway-raw-editor--copy-and-paste)
15. [The admin portal](#the-admin-portal)
16. [What the email looks like](#what-the-email-looks-like)
17. [What the SMS looks like](#what-the-sms-looks-like)
18. [Finding your UniFi door group IDs](#finding-your-unifi-door-group-ids)
19. [Setting up Resend for email](#setting-up-resend-for-email)
20. [Setting up Twilio for SMS](#setting-up-twilio-for-sms)
21. [Tech stack](#tech-stack)
22. [Contributing](#contributing)
23. [License](#license)
24. [Security notes](#security-notes)
25. [Troubleshooting](#troubleshooting)

---

## How it works

CourtPass runs as a background service. Every minute it:

1. Asks CourtReserve for all of today's confirmed reservations
2. For each reservation that starts within your notification window (default: 60 minutes) and has not been processed yet:
   - Creates a **Visitor** record in UniFi Access with an access window that starts `ACCESS_BUFFER_MINUTES` (default: 30 minutes) before the reservation
   - Generates a random PIN via the UniFi API
   - Assigns that PIN to the Visitor
   - Sends the member an **email** with the PIN, reservation details, and access start time
   - Optionally sends an **SMS** with the same information
3. After the reservation ends (plus a cleanup buffer), the Visitor record is deleted and the PIN stops working

Everything is driven by environment variables — no code changes are needed to customize it for your club.

---

## Example timeline

With default settings (`NOTIFY_MINUTES_BEFORE=60`, `ACCESS_BUFFER_MINUTES=30`, `CLEANUP_BUFFER_MINUTES=15`):

```
10:00 AM   Member books a court for 12:00 PM to 1:00 PM in CourtReserve

11:00 AM   CourtPass detects the reservation is 60 minutes away
            Creates a UniFi Visitor record with access window 11:30 AM to 1:00 PM
            Generates PIN: 67203419
            Sends email with subject: "Your Club Name Access PIN - Sun Mar 15, 12:00 PM"
            Sends SMS if enabled

11:30 AM   PIN becomes active
            Member enters 67203419 at the front door keypad and the door unlocks

12:00 PM   Reservation starts

 1:00 PM   Reservation ends

 1:15 PM   CourtPass deletes the Visitor record in UniFi
            PIN 67203419 no longer works at any door
```

If multiple players are on the same reservation, each player gets their own Visitor record and unique PIN.

---

## Requirements

### Software and accounts

| Requirement | Why it is needed | Where to get it |
|---|---|---|
| Node.js 18 or later | Runs the CourtPass code | nodejs.org |
| CourtReserve account with API access | Reads upcoming reservations | Your CourtReserve admin panel |
| UniFi Access version 1.9.1 or later | Creates visitors and assigns PINs | Already installed if you use UniFi doors |
| Resend account | Sends PIN emails via HTTPS | resend.com — free |
| Railway account | Hosts CourtPass 24/7 in the cloud | railway.app — free tier available |
| Twilio account (optional) | Sends PIN SMS messages | twilio.com — free trial |

### CourtReserve API permissions

CourtPass needs the **ReservationReport** role with **Read** permission enabled on your CourtReserve API key. This allows it to read today's reservations. It does not write anything back to CourtReserve.

To set this up:
1. Log into CourtReserve as an admin
2. Go to **Settings → API Access**
3. Create a new API key or edit an existing one
4. Make sure **ReservationReport → Read** is checked
5. Save and copy the API key — you will need it later

### UniFi Access API permissions

CourtPass needs an API token with two permission scopes:

- `view:credential` — allows it to generate PIN codes
- `edit:visitor` — allows it to create, update, and delete Visitor records

To create this token:
1. Log into **unifi.ui.com**
2. Click on your console
3. Go to **Access → Settings → General → Advanced**
4. Scroll to **API Token** and click **Create New**
5. Give it a name like `CourtPass`
6. Set the validity period to the longest available or no expiry
7. Check both `view:credential` and `edit:visitor`
8. Click **Create**
9. Copy the token immediately — it is only shown once

---

## Services you will need to set up

CourtPass relies on a few external services. Here is what each one does and how to set it up.

### Resend (email delivery)

CourtPass uses Resend to send emails rather than raw SMTP. Cloud hosting platforms like Railway block outbound SMTP ports (25, 465, 587). Resend sends over standard HTTPS (port 443) which is never blocked.

Resend's free tier includes 3,000 emails per month and 100 per day — more than enough for most clubs.

Setup steps:
1. Go to resend.com and create a free account
2. Go to **Domains → Add Domain**
3. Enter your club's domain such as yourclub.com
4. Resend shows you DNS records to add to prove you own the domain
5. Log into your DNS provider (Bluehost: Domains → DNS → Zone Editor)
6. Add each record exactly as shown in Resend
7. Back in Resend click **Verify DNS Records** — this usually takes 1 to 5 minutes
8. Once verified go to **API Keys → Create API Key**
9. Name it CourtPass and copy the key — you will need it for the RESEND_API_KEY variable

Testing without a domain: Resend provides a shared test sender `onboarding@resend.dev` that works before your domain is verified. Set `EMAIL_FROM=onboarding@resend.dev` temporarily. Note that emails from this address may land in spam.

### Twilio (SMS — optional)

Twilio sends SMS messages. CourtPass reads the phone number directly from CourtReserve reservation data so no extra member setup is needed. SMS is completely optional — CourtPass works fine with email only.

Twilio's free trial includes $15 credit which covers approximately 1,900 US SMS messages. After that, US SMS costs approximately $0.008 per message ($8 per 1,000 texts).

Setup steps:
1. Go to twilio.com and create an account
2. From the console dashboard copy your Account SID and Auth Token
3. Go to **Phone Numbers → Manage → Buy a Number**
4. Search for a local number and purchase it (approximately $1 per month)
5. Copy the phone number in E.164 format such as +13045550100
6. Add these values to your Railway environment variables

### Railway (hosting)

Railway is a cloud hosting platform. CourtPass is a long-running background process that needs to stay alive 24/7. Regular web hosting like Bluehost shared hosting is not suitable for this. Railway keeps it running reliably and redeploys automatically whenever you push code to GitHub.

Railway's free tier includes $5 of credit per month. CourtPass is lightweight and should fit within the free tier for most clubs.

---

## Installation and hosting options

CourtPass can be hosted in several different ways depending on your club's setup and technical comfort level. The code is identical regardless of where you run it — only the hosting method changes.

### Choosing a hosting method

| Method | Monthly cost | Technical level | Best for |
|---|---|---|---|
| Railway | Free to $5 | Beginner | Clubs with no local server hardware |
| Raspberry Pi | Free (hardware cost ~$50 one-time) | Beginner | Clubs that want local hosting and already have or want a Pi |
| Docker | Free | Intermediate | Clubs with a NAS, home server, or existing Docker setup |
| Synology / QNAP NAS | Free | Beginner | Clubs that already have a NAS running |
| VPS | $4 to $6/mo | Intermediate | Clubs that want cloud hosting with full control |
| Windows PC | Free | Beginner | Clubs with an always-on PC at the facility |

**Important note for local hosting (Pi, NAS, Windows PC, Docker):** When CourtPass runs on the same network as your UniFi console, you do not need port forwarding. Set `UNIFI_HOST=https://192.168.1.1:12445` using the local IP directly. This removes the most technically complex part of the setup.

---

## Option 1 — Railway (recommended for most clubs)

Railway is a cloud hosting platform that keeps CourtPass running 24/7 with zero server management. It deploys automatically from GitHub whenever you push an update.

Railway's free tier includes $5 of credit per month. CourtPass is lightweight and fits within the free tier for most clubs.

### Step 1 — Put your code on GitHub

Railway deploys directly from a GitHub repository.

1. Go to github.com and sign in or create a free account
2. Click the **+** icon in the top right and select **New repository**
3. Name it `courtpass` and set it to **Private**
4. Click **Create repository**
5. On the empty repo page click **uploading an existing file**
6. Upload all CourtPass files: `index.js`, `package.json`, `env.example`, `README.md`, `LICENSE`, `CONTRIBUTING.md`, `Dockerfile`, `docker-compose.yml`

Do NOT upload your `.env` file — it contains your credentials. Railway has its own secure place for these values.

7. Click **Commit changes**

### Step 2 — Create a Railway account

1. Go to railway.app
2. Click **Login → Login with GitHub**
3. Authorize Railway to access your GitHub account

### Step 3 — Create a new Railway project

1. From the Railway dashboard click **New Project**
2. Select **Deploy from GitHub repo**
3. If prompted click **Install and Authorize** and select your courtpass repo
4. Select the repo from the list

Railway starts an initial deployment. It will likely fail because you have not added environment variables yet. That is expected.

### Step 4 — Add environment variables

1. Click on your deployed service
2. Click the **Variables** tab
3. Click **Raw Editor**
4. Copy and paste the block from the Railway raw editor section below
5. Fill in all your actual values
6. Click **Update Variables**

Railway automatically redeploys when you save variables.

### Step 5 — Get your public URL

1. Click on your service
2. Click the **Settings** tab
3. Scroll down to **Networking**
4. Click **Generate Domain**
5. Railway gives you a URL like `courtpass-production.up.railway.app`

Bookmark `https://YOUR_RAILWAY_URL/admin` on your phone — this is your admin portal.

### Step 6 — Verify it is working

Click your service → **Deployments** tab → latest deployment → **View Logs**. You should see:

```
[INFO] CourtReserve <-> UniFi Access integration starting {"clubName":"Your Club"}
[INFO] Fetched 3 reservation(s)
[INFO] Scheduler running — checking every minute.
```

### Step 7 — Test with a real reservation

1. Create a test reservation in CourtReserve for 1 to 2 hours from now
2. In Railway temporarily change `NOTIFY_MINUTES_BEFORE` to `1440` so it picks up the reservation immediately
3. Watch the logs — within 60 seconds you should see the reservation processed and an email sent
4. Once confirmed working change `NOTIFY_MINUTES_BEFORE` back to `60`

---

## Option 2 — Raspberry Pi or local Linux machine

A Raspberry Pi 3 or newer will run CourtPass comfortably. Any other always-on Linux machine (old laptop, mini PC, home server) works the same way.

**Advantage over Railway:** Because the Pi is on the same local network as your UniFi console, no port forwarding is needed. Set `UNIFI_HOST` to the local IP address directly.

### Step 1 — Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Verify the installation:
```bash
node --version   # should show v20.x.x or later
```

### Step 2 — Download CourtPass

```bash
# If you have git installed:
git clone https://github.com/YOUR_USERNAME/courtpass.git
cd courtpass

# Or download and extract the zip from GitHub:
# Unzip it and cd into the folder
```

### Step 3 — Install dependencies

```bash
npm install
```

### Step 4 — Create your configuration file

```bash
cp env.example .env
nano .env
```

Fill in all your values. Since you are on the local network you can use the local IP:
```
UNIFI_HOST=https://192.168.1.1:12445
```

Save with Ctrl+O, exit with Ctrl+X.

### Step 5 — Test that it runs

```bash
npm start
```

You should see the startup log. Press Ctrl+C to stop once you have confirmed it works.

### Step 6 — Keep it running permanently with PM2

PM2 is a process manager that keeps CourtPass running and automatically restarts it if it crashes or the Pi reboots.

```bash
# Install PM2 globally
npm install -g pm2

# Start CourtPass with PM2
pm2 start index.js --name courtpass

# Save the process list so it survives reboots
pm2 save

# Enable PM2 to start on boot (run the command it prints)
pm2 startup
```

### Useful PM2 commands

```bash
pm2 status          # see if courtpass is running
pm2 logs courtpass  # view live logs
pm2 restart courtpass  # restart after changing .env
pm2 stop courtpass  # stop the service
```

---

## Option 3 — Docker

Docker packages CourtPass into a self-contained image that runs identically on any machine — a Raspberry Pi, a NAS, a VPS, or a home server. This is the most portable option.

CourtPass includes a `Dockerfile` and `docker-compose.yml` ready to use.

### Prerequisites

Install Docker on your machine. On Ubuntu or Raspberry Pi OS:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in for the group change to take effect
```

On other systems see docs.docker.com/get-docker.

### Option A — Docker Compose (recommended)

Docker Compose manages the container, volumes, and environment variables together.

1. Copy your environment file:
   ```bash
   cp env.example .env
   # Edit .env and fill in all your values
   ```

2. Start CourtPass:
   ```bash
   docker compose up -d
   ```

3. View logs:
   ```bash
   docker compose logs -f
   ```

4. Stop CourtPass:
   ```bash
   docker compose down
   ```

5. Restart after changing `.env`:
   ```bash
   docker compose down && docker compose up -d
   ```

CourtPass will automatically restart if it crashes or the machine reboots because of `restart: unless-stopped` in the compose file.

### Option B — Plain Docker run

If you prefer not to use Compose:

```bash
# Build the image
docker build -t courtpass .

# Run it (replace values with your own)
docker run -d   --name courtpass   --restart unless-stopped   --env-file .env   -v courtpass_data:/data   -p 3000:3000   courtpass
```

### Viewing logs with plain Docker

```bash
docker logs -f courtpass
```

### Updating CourtPass with Docker

When a new version is released:

```bash
git pull
docker compose down
docker compose up -d --build
```

---

## Option 4 — Synology or QNAP NAS

If your facility already has a NAS running, it can host CourtPass with no additional hardware.

### Synology NAS

1. Open **Package Center** and install **Container Manager**
2. Open Container Manager
3. Go to **Project → Create**
4. Upload or paste the contents of `docker-compose.yml`
5. Before starting, create a `.env` file with your credentials and reference it in the compose file or set environment variables in the UI
6. Click **Build** then **Start**

The admin portal will be accessible at `http://YOUR_NAS_IP:3000/admin` on your local network.

### QNAP NAS

1. Open **App Center** and install **Container Station**
2. Open Container Station
3. Go to **Create → Create Application**
4. Paste the contents of `docker-compose.yml`
5. Set your environment variables in the UI
6. Click **Create**

---

## Option 5 — VPS (DigitalOcean, Hetzner, Vultr)

A virtual private server gives you cloud hosting with full control — no Railway dependency, stable state file, and the ability to run other services on the same machine.

Recommended providers and their smallest plans:

| Provider | Monthly cost | Notes |
|---|---|---|
| Hetzner | ~$4 | Best value, European data centers |
| DigitalOcean | $6 | Beginner friendly, good documentation |
| Vultr | $6 | Good global coverage |
| Linode (Akamai) | $5 | Reliable, long established |

Any of these will work. Choose the cheapest option with 1GB RAM — CourtPass uses very little memory.

### Setup

1. Create the smallest Ubuntu server (Ubuntu 22.04 or 24.04 recommended)
2. SSH into it:
   ```bash
   ssh root@YOUR_SERVER_IP
   ```
3. Follow the exact same steps as Option 2 (Raspberry Pi) from Step 1 onward
4. The admin portal will be accessible at `http://YOUR_SERVER_IP:3000/admin`

Since a VPS is in the cloud (not on your local network), you still need port forwarding or a Cloudflare Tunnel to reach your UniFi console — see the Making your UniFi console reachable section.

---

## Option 6 — Windows PC

If there is a Windows PC at the facility that is always powered on, it can run CourtPass.

### Step 1 — Install Node.js

1. Go to nodejs.org
2. Download the **LTS** installer for Windows
3. Run the installer and follow the prompts
4. Open **Command Prompt** and verify: `node --version`

### Step 2 — Download CourtPass

1. Go to your GitHub repo and click **Code → Download ZIP**
2. Extract the ZIP to a folder like `C:\courtpass`
3. Open Command Prompt and navigate there:
   ```cmd
   cd C:\courtpass
   ```

### Step 3 — Install dependencies

```cmd
npm install
```

### Step 4 — Create your configuration file

1. Copy `env.example` and rename the copy to `.env`
2. Open `.env` in Notepad or any text editor
3. Fill in all your values
4. Save the file

### Step 5 — Test that it runs

```cmd
npm start
```

You should see the startup log. Press Ctrl+C to stop.

### Step 6 — Keep it running permanently

Install PM2 and the Windows startup helper:

```cmd
npm install -g pm2
npm install -g pm2-windows-startup
pm2 start index.js --name courtpass
pm2 save
pm2-startup install
```

CourtPass will now start automatically when Windows boots.

### Useful commands on Windows

```cmd
pm2 status             # check if running
pm2 logs courtpass     # view live logs
pm2 restart courtpass  # restart after changing .env
```

---

## Making your UniFi console reachable

### Step 1 — Put your code on GitHub

Railway deploys directly from a GitHub repository.

1. Go to github.com and sign in or create a free account
2. Click the **+** icon in the top right → **New repository**
3. Name it `courtpass`
4. Set it to **Private** — your configuration references real credentials
5. Click **Create repository**
6. On the empty repo page click **uploading an existing file**
7. Upload these files: `index.js`, `package.json`, `env.example`, `README.md`, `LICENSE`, `CONTRIBUTING.md`

Do NOT upload your `.env` file — it contains your passwords. Railway has its own secure place for these values.

8. Click **Commit changes**

### Step 2 — Create a Railway account

1. Go to railway.app
2. Click **Login → Login with GitHub**
3. Authorize Railway to access your GitHub account

### Step 3 — Create a new Railway project

1. From the Railway dashboard click **New Project**
2. Select **Deploy from GitHub repo**
3. If prompted click **Install and Authorize** and select your courtpass repo
4. Select the repo from the list

Railway will start an initial deployment. It will likely fail because you have not added environment variables yet. That is expected.

### Step 4 — Add environment variables

1. Click on your deployed service
2. Click the **Variables** tab
3. Click **Raw Editor**
4. Copy and paste the block from the Railway raw editor section below
5. Fill in all your actual values
6. Click **Update Variables**

Railway automatically redeploys when you save variables.

### Step 5 — Get your public URL

CourtPass includes a built-in admin portal accessible via browser.

1. Click on your service
2. Click the **Settings** tab
3. Scroll down to **Networking**
4. Click **Generate Domain**
5. Railway gives you a URL like `courtpass-production.up.railway.app`

Bookmark `https://YOUR_RAILWAY_URL/admin` on your phone.

### Step 6 — Verify it is working

1. Click your service → **Deployments** tab → latest deployment → **View Logs**

You should see:
```
[INFO] CourtReserve <-> UniFi Access integration starting {"clubName":"Your Club"}
[INFO] Fetched 3 reservation(s)
[INFO] Scheduler running — checking every minute.
```

If you see `Missing required environment variables` check that all required variables are filled in.

### Step 7 — Test with a real reservation

1. Create a test reservation in CourtReserve for 1 to 2 hours from now
2. In Railway temporarily change `NOTIFY_MINUTES_BEFORE` to `1440` (24 hours) so it picks up the reservation right away
3. Watch the logs — within 60 seconds you should see:
   ```
   [INFO] Processing player {"reservationId":"..."}
   [INFO] Player processed successfully {"pin":"67203419",...}
   [INFO] Email sent
   ```
4. Check the member's inbox for the PIN email
5. Once confirmed working change `NOTIFY_MINUTES_BEFORE` back to `60`

---

## All environment variables

Every aspect of CourtPass is controlled by environment variables. Here is a complete reference.

### CourtReserve

| Variable | Required | Default | Description |
|---|---|---|---|
| `CR_BASE_URL` | No | `https://api.courtreserve.com` | CourtReserve API base URL. Only change this if you have been given a custom URL by CourtReserve support. |
| `CR_ORG_ID` | Yes | — | Your organisation ID. Find it in the CourtReserve admin portal URL: the number after `/organization/`. |
| `CR_API_KEY` | Yes | — | Your API key. Found in CourtReserve Admin → Settings → API Access. |

CourtReserve uses HTTP Basic Authentication. `CR_ORG_ID` is sent as the username and `CR_API_KEY` as the password on every API request.

### UniFi Access

| Variable | Required | Default | Description |
|---|---|---|---|
| `UNIFI_HOST` | Yes | — | The full HTTPS URL of your UniFi console including port 12445. Example for local access: `https://192.168.1.1:12445`. Example for remote access: `https://yourclub.duckdns.org:12445`. |
| `UNIFI_API_TOKEN` | Yes | — | The API token created in UniFi. Must have `view:credential` and `edit:visitor` permission scopes. |
| `UNIFI_RESOURCES` | Recommended | — | The doors or door groups members can access. Format: `door_group:ID` for a group or `door:ID` for a single door. Separate multiple entries with commas and no spaces. Leave empty to run CourtPass without granting any door access (useful for testing email and SMS only). See Finding your UniFi door group IDs below. |

### Email

CourtPass supports two email transport modes. Set one or the other — not both. If `RESEND_API_KEY` is set it takes priority. If it is blank or absent, SMTP is used.

**Option A — Resend** (recommended for Railway and cloud hosting)

Resend sends email over HTTPS which is never blocked on cloud platforms. SMTP ports (25, 465, 587) are blocked on Railway's free and hobby tier.

| Variable | Required | Default | Description |
|---|---|---|---|
| `RESEND_API_KEY` | If using Resend | — | Your Resend API key. Created at resend.com → API Keys. Leave blank to use SMTP instead. |
| `EMAIL_FROM` | Yes | — | The sender address. When using Resend, must be from a domain verified in Resend. When using SMTP, must match your SMTP account. |

**Option B — SMTP** (recommended for local and self-hosted setups)

Use any standard SMTP server. On a local network there are no port restrictions so any email provider works — your existing hosting (Bluehost, Google Workspace, Microsoft 365), or a local SMTP server running on the same network.

| Variable | Required | Default | Description |
|---|---|---|---|
| `SMTP_HOST` | If using SMTP | — | Your SMTP server hostname. Example: `mail.yourclub.com` or `smtp.gmail.com` |
| `SMTP_PORT` | If using SMTP | `587` | SMTP port. Use `587` for STARTTLS (most common) or `465` for implicit TLS. |
| `SMTP_SECURE` | No | `false` | Set to `true` only when using port 465. Leave `false` for port 587. |
| `SMTP_USER` | If using SMTP | — | Your SMTP username, usually your full email address. |
| `SMTP_PASS` | If using SMTP | — | Your SMTP password or app password. |

### SMS (optional)

| Variable | Required | Default | Description |
|---|---|---|---|
| `TWILIO_ENABLED` | No | `false` | Set to `true` to send SMS in addition to email. All three Twilio variables below must also be set when this is true. |
| `TWILIO_ACCOUNT_SID` | If SMS enabled | — | Your Twilio Account SID. Found at the top of twilio.com/console. Always starts with `AC`. |
| `TWILIO_AUTH_TOKEN` | If SMS enabled | — | Your Twilio Auth Token. Found at the top of twilio.com/console next to the Account SID. |
| `TWILIO_FROM_NUMBER` | If SMS enabled | — | Your Twilio phone number in E.164 format. Example: `+13045550100`. Buy a number at twilio.com/console → Phone Numbers. |

### Branding

All emails and the admin portal can be customized to match your club without changing any code.

| Variable | Required | Default | Description |
|---|---|---|---|
| `BRAND_CLUB_NAME` | No | `Our Club` | Your club's name. Appears in the email header, subject line, SMS messages, and admin portal. |
| `BRAND_TAGLINE` | No | none | Optional subtitle shown below your club name in emails. Example: `Court Access System` |
| `BRAND_HEADER_COLOR` | No | `1a56db` | Background color of the email header. Enter the hex code WITHOUT the # symbol. Example: for the color #2e7d32 enter `2e7d32`. Visit htmlcolorcodes.com to find a color. |
| `BRAND_ACCENT_COLOR` | No | `1a56db` | Color used for the PIN digits, PIN box border, and detail sidebar in emails. Enter without the # symbol. |
| `BRAND_WEBSITE` | No | none | Your club's website URL. Shown in the email footer. Example: `https://yourclub.com` |
| `BRAND_PHONE` | No | none | Your club's phone number. Shown in the email footer. |
| `BRAND_ADDRESS` | No | none | Your club's physical address. Shown in the email footer. |

Important about hex colors: Railway treats the # character as the start of a comment and ignores everything after it on that line. Always enter hex colors without the #. The code adds it automatically. For the color #1a56db enter `1a56db`.

### Admin portal

| Variable | Required | Default | Description |
|---|---|---|---|
| `ADMIN_PORT` | No | `3000` | The port the admin web server listens on. Should match the PORT variable. |
| `PORT` | No | `3000` | Required by Railway to expose a public URL. Set to the same value as ADMIN_PORT. |
| `ADMIN_SECRET` | Yes | — | The password to log into the admin portal. Choose something strong — this protects access to all active member PINs. |

### Behaviour

| Variable | Required | Default | Description |
|---|---|---|---|
| `NOTIFY_MINUTES_BEFORE` | No | `60` | How many minutes before a reservation starts to send the PIN. The default of 60 means members receive their PIN 1 hour before their slot. |
| `ACCESS_BUFFER_MINUTES` | No | `30` | How many minutes before the reservation start the PIN becomes active. The default of 30 means members can enter the building 30 minutes early — useful for warming up. |
| `CLEANUP_BUFFER_MINUTES` | No | `15` | How many minutes after the reservation ends before the Visitor record is deleted and the PIN is revoked. The default of 15 gives members a short grace period to gather their belongings. |
| `TZ` | Yes on Railway | — | Your facility's timezone. This is critical when running on Railway, which operates in UTC. Without the correct timezone CourtPass will calculate reservation times incorrectly. Common values: `America/New_York`, `America/Chicago`, `America/Denver`, `America/Los_Angeles`, `America/Phoenix`. Full list at en.wikipedia.org/wiki/List_of_tz_database_time_zones. |
| `STATE_FILE` | No | `./state.json` | Path to the JSON file used to track which reservations have been processed. On Railway use `/tmp/state.json` so the file is written to a writable location. |

---

## Railway raw editor — copy and paste

In Railway go to your service → **Variables** tab → **Raw Editor**. Paste this block and fill in every value.

```
CR_BASE_URL=https://api.courtreserve.com
CR_ORG_ID=your_org_id_here
CR_API_KEY=your_api_key_here
UNIFI_HOST=https://YOUR_PUBLIC_IP_OR_HOSTNAME:12445
UNIFI_API_TOKEN=your_unifi_api_token_here
UNIFI_RESOURCES=
# Email — choose ONE transport:
# Option A: Resend (for Railway / cloud)
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxx
# Option B: SMTP (for local/self-hosted — leave RESEND_API_KEY blank)
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
NOTIFY_MINUTES_BEFORE=60
ACCESS_BUFFER_MINUTES=30
CLEANUP_BUFFER_MINUTES=15
TZ=America/New_York
STATE_FILE=/tmp/state.json
```

Click **Update Variables** when done. Railway will automatically redeploy.

### Variable quick reference

| Variable | Where to find the value |
|---|---|
| `CR_ORG_ID` | CourtReserve admin portal URL — the number after `/organization/` |
| `CR_API_KEY` | CourtReserve Admin → Settings → API Access |
| `UNIFI_HOST` | Your public IP or DuckDNS hostname plus port 12445 |
| `UNIFI_API_TOKEN` | UniFi Portal → Access → Settings → General → Advanced → API Token |
| `UNIFI_RESOURCES` | See Finding your UniFi door group IDs below |
| `RESEND_API_KEY` | resend.com → API Keys → Create API Key |
| `EMAIL_FROM` | Any address at your verified Resend domain. Use `onboarding@resend.dev` for testing. |
| `TWILIO_ACCOUNT_SID` | Top of twilio.com/console |
| `TWILIO_AUTH_TOKEN` | Top of twilio.com/console |
| `TWILIO_FROM_NUMBER` | twilio.com/console → Phone Numbers |
| `ADMIN_SECRET` | Choose any strong password — this is the admin portal login |
| `TZ` | Your timezone. Example: `America/New_York` |
| `BRAND_HEADER_COLOR` | Hex color without the # symbol. Example: `1a56db` for blue |

---

## The admin portal

The admin portal is a mobile-friendly web page built into CourtPass. It lets club staff look up PINs and resend them without logging into Railway or UniFi.

### Accessing the portal

Your portal URL is `https://YOUR_RAILWAY_URL/admin`. Bookmark this on your phone — you will use it whenever a member has trouble getting in.

### Logging in

Enter your `ADMIN_SECRET` password on the login screen. Your browser saves a session cookie so you stay logged in. You only need to enter the password once per device. Tap **Log out** when you are done on a shared device.

### What the dashboard shows

Each card on the dashboard represents one active reservation and displays:

- **Member name** — from the CourtReserve account
- **Email address** — where the PIN was sent
- **Phone number** — tappable to call directly from your phone
- **Court name** — which court was booked
- **Date** — the reservation date
- **Time range** — start to end time shown as a badge
- **Reservation ID** — the CourtReserve number for reference
- **Access PIN** — displayed in large easy-to-read digits

### Searching

Type in the search bar to filter by any field — member name, email, court name, PIN digits, or reservation ID. Results update instantly. The count badge shows how many are visible.

### Resending a PIN

If a member did not receive their email, deleted it, or cannot find it:

1. Search for the member by name
2. Find their reservation card
3. Tap **Resend**
4. CourtPass immediately resends the email and SMS if enabled
5. A confirmation appears: `Resent to member@email.com`

### Why the PIN is stored in the portal

UniFi Access is designed so that once a PIN is assigned to a Visitor, the actual digits cannot be retrieved through the API — only a cryptographic hash is stored. CourtPass saves the PIN digits at creation time in both the Railway logs and the state file so admins can look them up here.

---

## What the email looks like

Members receive an HTML email containing:

- Club name and optional tagline in the header styled in your brand colors
- Member first name in the greeting
- PIN displayed in large digits in a highlighted box
- Active from time — when they can start using the PIN
- Court name, start time, and end time
- A notice explaining when the PIN expires and not to share it
- Club contact information in the footer if configured

Subject line format:
```
Your Club Name Access PIN - Mon Mar 16, 12:00 PM
```

---

## What the SMS looks like

If Twilio is enabled members receive a text message:

```
Your Club Name — Building Access PIN

Hi Joel,
PIN: 67203419
Active from: Mon Mar 16, 11:30 AM
Court: Total Athlete Court #1
Start: Mon Mar 16, 12:00 PM

Do not share this PIN. Reply STOP to opt out.
```

CourtPass automatically formats phone numbers into E.164 format regardless of how they are stored in CourtReserve. For example `304-830-0626` becomes `+13048300626`.

---

## Finding your UniFi door group IDs

You need the ID of the door group or individual door that members should access. There are two ways to find this.

### Method A — From the UniFi UI

1. Log into your UniFi console locally or via unifi.ui.com
2. Open the **Access** application
3. Go to **Settings → Door Groups** or **Spaces**
4. Click on the door group you want members to access
5. Look at the URL in your browser — the door group ID is the long string at the end. For example in the URL `.../door-groups/9bee6e0e-108d-4c52-9107-76f2c7dea4f1` the ID is `9bee6e0e-108d-4c52-9107-76f2c7dea4f1`

### Method B — Via the API

From any computer on the same local network as your UniFi console, run this command in Terminal (Mac) or Command Prompt (Windows). Replace the IP address and token with your values.

```bash
curl -sk \
  -H "Authorization: Bearer YOUR_UNIFI_API_TOKEN" \
  "https://192.168.1.1:12445/api/v1/developer/door_groups/topology" \
  | python3 -m json.tool
```

The output shows all your door groups with their IDs and the doors inside each group.

### Setting the variable

```
# A whole door group — all doors in the group are accessible:
UNIFI_RESOURCES=door_group:9bee6e0e-108d-4c52-9107-76f2c7dea4f1

# A single specific door:
UNIFI_RESOURCES=door:6ff875d2-af87-470b-9cb5-774c6596afc8

# Multiple entries — separate with commas and no spaces:
UNIFI_RESOURCES=door_group:9bee6e0e-108d-4c52-9107-76f2c7dea4f1,door:6ff875d2-af87-470b-9cb5-774c6596afc8
```

---

## Email transport options

CourtPass supports two email delivery methods. Which one to use depends on how you are hosting CourtPass.

### When to use Resend

Use Resend if you are running CourtPass on **Railway or any other cloud platform**. Cloud platforms block outbound SMTP ports (25, 465, 587) as an anti-spam measure. Resend sends email over HTTPS (port 443) which is never blocked. It has a generous free tier and takes about 10 minutes to set up.

### When to use SMTP

Use SMTP if you are running CourtPass **locally** — on a Raspberry Pi, NAS, VPS, or Windows PC on your facility's network. On a local machine there are no port restrictions so you can use:

- Your existing email hosting (Bluehost, Google Workspace, Microsoft 365, etc.)
- Gmail with an app password
- A local SMTP server running on the same network

To switch to SMTP mode, leave `RESEND_API_KEY` blank (or remove it entirely) and fill in the `SMTP_*` variables instead.

**Common SMTP settings:**

| Provider | SMTP Host | Port | Secure |
|---|---|---|---|
| Bluehost | `mail.yourdomain.com` | 465 | true |
| Gmail | `smtp.gmail.com` | 587 | false |
| Google Workspace | `smtp.gmail.com` | 587 | false |
| Microsoft 365 | `smtp.office365.com` | 587 | false |
| Mailhog (local testing) | `localhost` | 1025 | false |
| Any cPanel host | `mail.yourdomain.com` | 587 | false |

**Gmail app password:** If using Gmail or Google Workspace, your regular password will not work — you need to create an App Password. Go to myaccount.google.com → Security → 2-Step Verification → App passwords. Create one named `CourtPass` and use it as `SMTP_PASS`.

### Running a local SMTP server (fully self-hosted)

If you want no external email dependency at all, you can run a local SMTP server on the same machine or network as CourtPass.

**Mailhog** — for testing only, does not actually deliver mail, but lets you view all sent emails in a web UI:
```bash
# Install on Linux
wget https://github.com/mailhog/MailHog/releases/latest/download/MailHog_linux_amd64
chmod +x MailHog_linux_amd64
./MailHog_linux_amd64
# Web UI at http://localhost:8025
# SMTP at localhost:1025
```

Set in your `.env`:
```
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
EMAIL_FROM=noreply@yourclub.com
```

**Postfix** — the standard Linux mail server, delivers real email:
```bash
sudo apt install postfix
# Choose "Internet Site" during setup
# Enter your domain name when prompted
```

Set in your `.env`:
```
SMTP_HOST=localhost
SMTP_PORT=25
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
EMAIL_FROM=noreply@yourclub.com
```

Note that delivering email directly from a self-hosted Postfix server often results in spam filtering unless you configure SPF, DKIM, and DMARC DNS records for your domain. For most clubs, using your existing email hosting via SMTP is simpler and more reliable than running a full mail server.

---

## Setting up Resend for email

1. Go to resend.com and create a free account
2. Go to **Domains → Add Domain** and enter your domain
3. Resend shows DNS records to add. Add each one in your DNS provider:
   - Bluehost: Domains → DNS → Zone Editor → Add Record
   - GoDaddy: DNS → Add
   - Cloudflare: DNS → Add Record
4. Back in Resend click **Verify DNS Records**. This usually takes 1 to 5 minutes. If it fails wait a few minutes and try again.
5. Once your domain shows as Verified go to **API Keys → Create API Key**
6. Name it CourtPass with Sending access
7. Click Create and copy the key immediately — it is only shown once
8. Set these Railway variables:
   ```
   RESEND_API_KEY=re_your_key_here
   EMAIL_FROM=noreply@yourclub.com
   ```

---

## Setting up Twilio for SMS

1. Go to twilio.com and create an account
2. Verify your email and phone number
3. From the console at console.twilio.com copy your Account SID and Auth Token
4. Go to **Phone Numbers → Manage → Buy a Number** and purchase one with SMS capability
5. Copy the number in E.164 format such as `+13045550100`
6. Set these Railway variables:
   ```
   TWILIO_ENABLED=true
   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   TWILIO_AUTH_TOKEN=your_auth_token
   TWILIO_FROM_NUMBER=+15550000000
   ```

Free trial note: Twilio's free trial only sends SMS to verified phone numbers. To send to unverified numbers you need to add a credit card to your Twilio account. You are not charged until you exceed the free trial credit.

---

## Tech stack

| Layer | Technology | Why |
|---|---|---|
| Reservation data | CourtReserve API | Reads today's bookings and player details |
| Door access | UniFi Access API | Creates Visitors and assigns PINs |
| Email delivery | Resend | Sends email over HTTPS — works on Railway |
| SMS delivery | Twilio | Reliable SMS with phone number purchasing |
| Hosting | Railway | Keeps the process running 24/7 in the cloud |
| HTTP client | axios | All API requests |
| Scheduler | node-cron | Runs the check every minute |
| Runtime | Node.js 18+ | JavaScript server runtime |

---

## Contributing

Contributions are welcome. See CONTRIBUTING.md for full guidelines.

In short: fork the repo, make your changes on a branch, and open a pull request with a clear description of what changed and why.

---

## License

MIT — see LICENSE for the full text. You are free to use, modify, and distribute CourtPass in your own projects including commercially.

---

## Security notes

- Rotate your `UNIFI_API_TOKEN` and `CR_API_KEY` periodically and immediately if they are ever accidentally exposed such as in a public GitHub commit.
- Use a strong random string for `ADMIN_SECRET`. Anyone with this password can see all active member PINs and resend them. Treat it like a real password — at least 16 random characters.
- UniFi's self-signed TLS certificate is intentionally bypassed by CourtPass. This is expected and documented by Ubiquiti. The UniFi Access console generates its own certificate that is not trusted by public certificate authorities.
- PINs are stored in plaintext in Railway logs and the state.json file for admin recovery purposes. Restrict Railway project access to trusted team members only.
- The admin portal uses HttpOnly session cookies. Your password is never stored in the browser — only a session token that expires when you log out.
- Port forwarding exposes port 12445 to the internet. Consider using a Cloudflare Tunnel if you prefer not to open any ports on your router.

---

## Troubleshooting

### The service will not start

Symptom: `Missing required environment variables: CR_ORG_ID, CR_API_KEY` or similar in logs.

Fix: Open Railway → Variables tab and make sure every required variable has a value. Required variables are marked Yes in the All environment variables section above.

---

### CourtReserve returns 0 reservations

Symptom: Logs show `Fetched 0 reservation(s)` even though reservations exist.

Possible causes:

1. `TZ` is not set — Railway runs in UTC. Without the correct timezone CourtPass queries the wrong date. Set `TZ=America/New_York` or your timezone.
2. The reservation is in the past — CourtPass only fetches today's reservations. Create a new test reservation.
3. Wrong credentials — double-check `CR_ORG_ID` and `CR_API_KEY`.
4. Missing API role — the API key must have ReservationReport → Read permission in CourtReserve Admin → Settings → API Access.

---

### CourtReserve returns a date range error

Symptom: `CourtReserve API error: Currently, this report cannot be run for a period longer than 31 days`

Fix: This happens if `NOTIFY_MINUTES_BEFORE` is set to a very large value and the query range crosses midnight. Set it back to `60` for normal operation.

---

### UniFi returns CODE_UNAUTHORIZED

Symptom: `Create visitor failed: {"code":"CODE_UNAUTHORIZED",...}`

Fix: The API token is missing required permission scopes. Delete it in UniFi and create a new one with both `view:credential` and `edit:visitor` checked.

---

### UniFi connection times out

Symptom: `Failed to create UniFi visitor {"err":"timeout of 15000ms exceeded"}`

Fix: Railway cannot reach your UniFi console. Work through the Making your UniFi console reachable section. Specifically check:
- Port forwarding is saved correctly in UniFi
- The firewall rule exists and is set to Internet Local or Internet In as appropriate
- portchecker.co shows port 12445 as Open on your public IP
- `UNIFI_HOST` in Railway matches your public IP or hostname exactly including the port

---

### Email fails to send

Symptom: `Failed to send email` in the logs.

Fix:
1. Verify `RESEND_API_KEY` is correct — log into resend.com and confirm the key exists
2. Verify your domain is confirmed in Resend → Domains with a green Verified status
3. Make sure `EMAIL_FROM` uses an address at your verified domain
4. For testing try `EMAIL_FROM=onboarding@resend.dev` to rule out domain issues

---

### SMS fails to send

Symptom: `Failed to send SMS` in the logs.

Fix:
1. Confirm `TWILIO_ENABLED=true` is set
2. Verify all three Twilio variables are correct
3. On a free trial Twilio only sends to verified numbers — go to twilio.com/console → Verified Caller IDs or upgrade your account
4. Confirm the member has a phone number stored in CourtReserve — CourtPass skips SMS if no phone number is present

---

### The same reservation is processed multiple times

Symptom: A member receives duplicate PIN emails.

Cause: The state file was reset. This can happen if Railway restarted and cleared `/tmp/state.json` or if you changed the `STATE_FILE` variable.

Fix: This is harmless — the member receives an extra notification. Duplicate Visitor records in UniFi are cleaned up automatically after the reservation ends. To minimize this happening use a persistent volume for the state file (advanced).

---

### The admin portal is not accessible

Symptom: The `/admin` URL returns an error or does not load.

Fix:
1. Confirm both `PORT=3000` and `ADMIN_PORT=3000` are set in Railway variables
2. Go to Railway → your service → Settings → Networking and confirm a domain has been generated
3. Check the Deployments tab to confirm the latest deployment succeeded with no errors

---

### PIN becomes active at the wrong time

Symptom: Members can enter too early or the PIN is not active when they arrive.

Fix:
- `TZ` must exactly match your facility's timezone
- `ACCESS_BUFFER_MINUTES` controls how early the PIN activates before the reservation start
- If times are consistently off by a fixed number of hours `TZ` is likely set incorrectly

---

### Visitor records pile up in UniFi after reservations end

Symptom: Old Visitor records remain in UniFi Access long after reservations have ended.

Fix: CourtPass deletes expired visitors every minute, `CLEANUP_BUFFER_MINUTES` after the reservation end time. If records are not being deleted check:
1. The Railway service is still running (check the Deployments tab)
2. `CLEANUP_BUFFER_MINUTES` is set to a reasonable value
3. The UniFi API token is still valid and has `edit:visitor` permission
