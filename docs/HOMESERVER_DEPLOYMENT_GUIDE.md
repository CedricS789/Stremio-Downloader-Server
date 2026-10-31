# Home Server Deployment & Multi-Device Stremio Architecture Guide

> **Target Machine:** Dedicated Linux Home Server (Ubuntu / Debian / Arch / Raspberry Pi, x86_64 or ARM64)  
> **Repository:** [CedricS789/Stremio-Local-Media-Server](https://github.com/CedricS789/Stremio-Local-Media-Server)  
> **Target Clients:** Windows Desktop (Native App), iPhone (Stremio Web PWA), iPad (Stremio Web PWA), Android / Smart TVs  
> **Status:** Production-Ready Self-Hosted Media Engine

---

## 1. Executive Summary & Architecture Vision

**Stremio-Local-Media-Server** runs 24/7 on your dedicated home server or mini-PC.

### The "100% Pure Stremio" Philosophy
Unlike traditional setups that require heavy media servers like Plex or Jellyfin:
* **No Plex or Jellyfin required:** Stremio-Local-Media-Server operates directly as a native Stremio streaming and catalog addon server.
* **Unified Single Interface:** Media discovery, debrid stream selection, 1-click downloading, and playback all happen **100% inside Stremio** across all your devices.
* **Zero Server Transcoding:** Video playback is delivered via **HTTP Direct Play**. Decoding is offloaded to client hardware (iPhone, iPad, PC GPU), eliminating CPU strain on the server.
* **Dual-Stream Playback Engine:** When a file is downloaded, Stremio automatically provides two streams:
  1. `💾 Local (LAN Direct)` (`http://<SERVER_LAN_IP>:60500/media/...`): 100% Gigabit LAN, 0 Internet data, instant scrubbing.
  2. `💾 Local (Remote / HTTPS)` (`https://dock.yourdomain.com/media/...`): For watching when away from home without needing a VPN.

```mermaid
flowchart TD
    subgraph Clients["Your Devices"]
        PC["Windows PC<br>(Stremio Desktop App)"]
        iPhone["iPhone<br>(Stremio Web + Outplayer)"]
        iPad["iPad<br>(Stremio Web + Outplayer)"]
    end

    subgraph HomeServer["Home Server (24/7 Always-On)"]
        MMD["Stremio-Local-Media-Server (Docker)<br>Port 60500"]
        CFTunnel["Cloudflare Tunnel<br>(cloudflared)"]
        Cron["Storage Monitor (Cron)<br>100 GB Soft Limit"]
        Disk[("Storage SSD / HDD<br>/media/movies & /media/tv")]
    end

    Clients -->|1. Find show & click 'Download'| MMD
    MMD -->|2. Pull stream from Debrid| Disk
    Disk -->|3. Gigabit Direct Play (LAN Direct)| Clients
    CFTunnel -.->|Remote HTTPS Playback (Zero VPN)| iPhone & iPad
    Cron -->|Monitors 80 GB & 100 GB thresholds| Disk
```

---

## 2. Server Deployment Details

The application is deployed with the following parameters:

* **Host Directory:** `~/stremio-dock`
  * Application: `~/stremio-dock/app`
  * Media Movies: `~/stremio-dock/media/movies`
  * Media TV: `~/stremio-dock/media/tv`
  * Storage Monitor: `~/stremio-dock/monitor`
* **Docker Container:** `stremio-local-media-server`
  * Image: `stremio-local-media-server:latest`
  * Default Port: `60500`
  * Health Endpoint: `http://localhost:60500/health`
  * Web Downloads & Storage Dashboard: `http://localhost:60500/downloads`

---

## 3. Storage Soft Limit (100 GB Default)

To safeguard system stability while keeping ample room for server operations:
* **Soft Limit:** **100 GB** decimal (`100,000,000,000 bytes`).
* **Warning Threshold:** **80 GB** decimal (`80,000,000,000 bytes`).
* **Automated Cron Monitor:** Runs every 15 minutes via:
  ```bash
  */15 * * * * ~/stremio-dock/monitor/check-media-space.sh >> ~/stremio-dock/monitor/cron.log 2>&1
  ```
* **Behavior:** Non-destructive soft limit. It logs warnings to `~/stremio-dock/monitor/storage-warning.log` so you can delete watched seasons before reaching disk capacity.

---

## 4. Cloudflare Zero Trust Setup (HTTPS Tunnel)

Because Stremio's UI runs inside a secure web context (`https://app.strem.io` and `https://web.stremio.com`), installing the addon across phones, tablets, and desktop without mixed-content errors requires an HTTPS manifest URL.

### Steps to activate your custom domain (e.g. `dock.yourdomain.com`):
1. Log into your [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/).
2. Navigate to **Networks** → **Tunnels**.
3. Select your active tunnel and click **Configure**.
4. In the **Public Hostname** tab, click **Add a public hostname**:
   * **Subdomain:** `dock` (or your choice)
   * **Domain:** `yourdomain.com`
   * **Service Type:** `HTTP`
   * **URL:** `stremio-local-media-server:60500` (or `localhost:60500`)
5. Click **Save hostname**.

---

## 5. Adding the Addon to Stremio

Once your server is running and optional HTTPS is configured:

### Stremio Manifest URL:
```text
https://dock.yourdomain.com/addon/<YOUR_ACCESS_TOKEN>/manifest.json
```
*(Copy your personalized manifest URL from the Admin Console at `/admin` under Settings)*

### Installation Steps:
1. Open Stremio (on PC, Mac, iPhone, iPad, or Android).
2. Go to **Addons** (puzzle piece icon).
3. Paste your manifest URL into the search bar.
4. Click **Install**.
5. Once installed, Stremio automatically syncs this addon to all devices logged into your Stremio account!

---

## 6. Multi-Device Playback Guide

### At Home on Local Wi-Fi (Gigabit LAN • 0 Internet Data):
* When you open any downloaded movie or series in Stremio, select the stream marked:
  **`💾 Local (LAN Direct)`** (`⚡ Gigabit LAN • No Internet`).
* Playback streams directly from your home server over your local Wi-Fi router.
* No data touches the internet; no VPN is needed.

### Away from Home (4G/5G Cellular / Traveling):
* In Stremio, select:
  **`💾 Local (Remote / HTTPS)`**.
* Playback streams securely through your HTTPS tunnel with zero VPN connection required on your phone.

### Mobile Device Tips (iPhone & iPad):
1. **PWA Installation:** Open `https://web.stremio.com` in Safari, tap **Share** → **Add to Home Screen**.
2. **External Player:** Go to **Stremio Web Settings** → **Streaming** and select **Play in external player** → **Outplayer** or **VLC** (both free on the App Store).
3. **1-Click Downloading:** Clicking **"⬇️ Download Season"** sends the download task to your server. The server downloads it silently without using your phone's battery or cellular storage.

---

## 7. Operations & Maintenance Cheat Sheet

### Check Container Status
```bash
docker ps --filter "name=stremio-local-media-server"
```

### View Live Logs
```bash
docker logs -f stremio-local-media-server
```

### Restart Container
```bash
cd ~/stremio-dock/app && docker compose restart
```

### Check Storage Usage & Monitor Status
```bash
du -sh ~/stremio-dock/media/*; cat ~/stremio-dock/monitor/last-warning-level
```

### Update to Latest Code from GitHub
```bash
cd ~/stremio-dock/app && docker compose up -d --build
```
