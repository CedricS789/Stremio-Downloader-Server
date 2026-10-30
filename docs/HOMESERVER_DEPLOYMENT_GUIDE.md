# Home Server Deployment & Multi-Device Stremio Architecture Guide

> **Target Machine:** `asus_server` (Ubuntu Linux x86_64)  
> **Repository:** [CedricS789/My-Media-Dock](https://github.com/CedricS789/My-Media-Dock)  
> **Target Clients:** Windows Desktop (Native App), iPhone (Stremio Web PWA), iPad (Stremio Web PWA), Android / Smart TVs  
> **Status:** **Deployed & Operational** (Healthy container running on `asus_server`)  

---

## 1. Executive Summary & Architecture Vision

**My-Media-Dock** is now deployed and running 24/7 on your dedicated Home Server (`asus_server`).

### The "100% Pure Stremio" Philosophy
Unlike traditional setups that require heavy media servers like Plex or Jellyfin:
* **No Plex or Jellyfin required:** My-Media-Dock operates directly as a native Stremio streaming and catalog addon server.
* **Unified Single Interface:** Media discovery, debrid stream selection, 1-click downloading, and playback all happen **100% inside Stremio** across all your devices.
* **Zero Server Transcoding:** Video playback is delivered via **HTTP Direct Play**. Decoding is offloaded to client hardware (iPhone A-series, iPad M/A-series, PC GPU), eliminating CPU strain on the server.
* **Dual-Stream Playback Engine:** When a file is downloaded, Stremio automatically provides two streams:
  1. `💾 Local (LAN Direct)` (`http://192.168.1.50:60500/media/...`): 100% Gigabit LAN, 0 Internet data, instant scrubbing.
  2. `💾 Local (Remote / HTTPS)` (`https://dock.yourdomain.com/media/...`): For watching when away from home without needing a VPN.

```mermaid
flowchart TD
    subgraph Clients["Your Devices"]
        PC["Windows PC<br>(Stremio Desktop App)"]
        iPhone["iPhone<br>(Stremio Web + Outplayer)"]
        iPad["iPad<br>(Stremio Web + Outplayer)"]
    end

    subgraph HomeServer["asus_server (24/7 Always-On)"]
        MMD["My-Media-Dock (Docker)<br>Port 60500"]
        CFTunnel["Cloudflare Tunnel<br>(asus-cloudflare-cloudflared-1)"]
        Cron["Storage Monitor (Cron)<br>100 GB Soft Limit"]
        Disk[("Crucial SSD / Storage<br>/media/movies & /media/tv")]
    end

    Clients -->|1. Find show & click 'Download'| MMD
    MMD -->|2. Pull stream from Debrid| Disk
    Disk -->|3. Gigabit Direct Play (LAN Direct)| Clients
    CFTunnel -.->|Remote HTTPS Playback (Zero VPN)| iPhone & iPad
    Cron -->|Monitors 80 GB & 100 GB thresholds| Disk
```

---

## 2. Live Server Deployment Details

The application is deployed on `asus_server` with the following active parameters:

* **Host Directory:** `~/stremio-dock`
  * Application: `~/stremio-dock/app`
  * Media Movies: `~/stremio-dock/media/movies`
  * Media TV: `~/stremio-dock/media/tv`
  * Storage Monitor: `~/stremio-dock/monitor`
* **Docker Container:** `my-media-dock`
  * Image: `my-media-dock:latest`
  * Bound Ports:
    * `192.168.1.50:60500` (Home LAN Gigabit Ethernet)
    * `100.x.y.z:60500` (Tailscale mesh)
    * `127.0.0.1:60500` (Local loopback)
  * Docker Network: Attached to `app-edge` with alias `dock-origin`
* **Addon Credentials & Token:**
  * Admin Username: `admin`
  * Addon Token: `<YOUR_ACCESS_TOKEN>`
* **Health & Diagnostics:**
  * Health Endpoint: `http://192.168.1.50:60500/health`
  * Web Downloads & Storage Dashboard: `http://192.168.1.50:60500/downloads`

---

## 3. Storage Soft Limit (100 GB)

To safeguard system stability while keeping ample room for server operations:
* **Soft Limit:** **100 GB** decimal (`100,000,000,000 bytes`).
* **Warning Threshold:** **80 GB** decimal (`80,000,000,000 bytes`).
* **Automated Cron Monitor:** Runs every 15 minutes via:
  ```bash
  */15 * * * * ~/stremio-dock/monitor/check-media-space.sh >> ~/stremio-dock/monitor/cron.log 2>&1
  ```
* **Behavior:** Non-destructive soft limit. It logs warnings to `~/stremio-dock/monitor/storage-warning.log` and the system journal (`journalctl -t my-media-dock-storage`) so you can delete watched seasons before reaching disk capacity.

---

## 4. Cloudflare Zero Trust Setup (1-Minute Hostname)

Because Stremio's UI runs inside a secure web context (`https://app.strem.io` and `https://web.stremio.com`), installing the addon across phones, tablets, and desktop without mixed-content errors requires an HTTPS manifest URL.

Your server already has the Cloudflare Tunnel container `asus-cloudflare-cloudflared-1` running on the `app-edge` network.

### Steps to activate `dock.yourdomain.com`:
1. Log into your [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/).
2. Navigate to **Networks** → **Tunnels**.
3. Select your active tunnel (`asus_server`) and click **Configure**.
4. In the **Public Hostname** tab, click **Add a public hostname**:
   * **Subdomain:** `dock`
   * **Domain:** `yourdomain.com`
   * **Service Type:** `HTTP`
   * **URL:** `dock-origin:60500` (or `http://dock-origin:60500`)
5. Click **Save hostname**.

---

## 5. Adding the Addon to Stremio

Once the hostname is added:

### Stremio Manifest URL:
```text
https://dock.yourdomain.com/addon/<YOUR_ACCESS_TOKEN>/manifest.json
```

### Installation Steps:
1. Open Stremio (on PC, Mac, iPhone, iPad, or Android).
2. Go to **Addons** (puzzle piece icon).
3. Paste the manifest URL into the search bar.
4. Click **Install**.
5. Once installed, Stremio automatically syncs this addon to all devices logged into your Stremio account!

---

## 6. Multi-Device Playback Guide

### At Home on Local Wi-Fi (Gigabit LAN • 0 Internet Data):
* When you open any downloaded movie or series in Stremio, select the stream marked:
  **`💾 Local (LAN Direct)`** (`⚡ Gigabit LAN • No Internet`).
* Playback streams directly from `asus_server` (`192.168.1.50`) over your home Wi-Fi router.
* No data touches the internet; no VPN is needed.

### Away from Home (4G/5G Cellular / Traveling):
* In Stremio, select:
  **`💾 Local (Remote / HTTPS)`**.
* Playback streams securely through `dock.yourdomain.com` with zero VPN connection required on your phone.

### Mobile Device Tips (iPhone & iPad):
1. **PWA Installation:** Open `https://web.stremio.com` in Safari, tap **Share** → **Add to Home Screen**.
2. **External Player:** Go to **Stremio Web Settings** → **Streaming** and select **Play in external player** → **Outplayer** or **VLC** (both free on the App Store).
3. **1-Click Downloading:** Clicking **"⬇️ Download Season"** sends the download task to `asus_server`. The server downloads it silently without using your phone's battery or cellular storage.

---

## 7. Operations & Maintenance Cheat Sheet

### Check Container Status
```bash
ssh asus_server "docker ps --filter 'name=my-media-dock'"
```

### View Live Logs
```bash
ssh asus_server "docker logs -f my-media-dock"
```

### Restart Container
```bash
ssh asus_server "cd ~/stremio-dock/app && docker compose restart"
```

### Check Storage Usage & Monitor Status
```bash
ssh asus_server "du -sh ~/stremio-dock/media/*; cat ~/stremio-dock/monitor/last-warning-level"
```

### Update to Latest Code from GitHub
```bash
ssh asus_server "cd ~/stremio-dock/app && docker compose up -d --build"
```
