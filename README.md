# Stremio-Local-Media-Server 🎬💾

> **The Zero-Transcode, Plex-less Personal Media Server & Downloader for Stremio.**  
> Seamlessly select, download, and stream Debrid media directly inside Stremio across all your devices with **Gigabit LAN direct play** at home and **zero-VPN remote streaming** away from home.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-Compatible-2496ED?logo=docker&logoColor=white)](compose.yaml)
[![Stremio](https://img.shields.io/badge/Stremio-Addon-7B5BF2?logo=stremio&logoColor=white)](https://stremio.com)

---

## 💡 Why Stremio-Local-Media-Server?

Traditional personal media setups (like Plex, Jellyfin, or Emby) force you to maintain a heavy second ecosystem: separate apps, library sync daemons, and CPU-melting live video transcoding.

**Stremio-Local-Media-Server replaces that entire stack with a 100% native Stremio addon:**

* **Pure Stremio Interface:** No app switching. Media discovery, stream selection, 1-click downloading, library browsing, and playback all live **100% inside Stremio**.
* **Zero Server Transcoding:** Streams are served via **HTTP Direct Play**. Modern phones (iPhone/Android), tablets, and PCs decode 4K and 1080p REMUX video on hardware with zero CPU strain on your server.
* **Dual-Stream Playback Engine:**
  * **`🏠 LAN Direct`**: Streams directly over your home Wi-Fi/Gigabit router (`192.168.x.x`) with **0 MB internet data used** and instant scrubbing.
  * **`🌐 Remote`**: Secure HTTPS streaming via Cloudflare Tunnel when you are outside the house on 4G/5G or traveling—**no VPN required**.
* **Interactive Source & Quality Picker:** Pick your exact release profile (4K UHD, 1080p Bluray, REMUX, HDR/DV, English/French audio) or download entire TV seasons with 1 click.
* **Proactive Storage Quota:** Built-in allocation limit (`MEDIA_ALLOCATED_LIMIT_GB=100`) with pre-download space verification and real-time visual progress bars.
* **Universal Multi-Device Sync:** Windows Desktop, macOS, Linux, iPhone (PWA), iPad (PWA), Android, and Smart TVs.

```mermaid
flowchart TD
    subgraph Clients["Your Devices"]
        PC["Windows / Mac / Linux<br>(Stremio Desktop)"]
        Phone["iPhone / Android<br>(Stremio Web + Outplayer / VLC)"]
        TV["iPad / Tablet / TV<br>(Stremio App)"]
    end

    subgraph Server["Stremio-Local-Media-Server (Home Server or PC)"]
        SDS["Stremio-Local-Media-Server (Docker Engine)<br>Port 60500"]
        Disk[("Local Storage<br>/media/movies & /media/tv")]
        CF["Cloudflare Tunnel<br>(HTTPS Zero-VPN Route)"]
    end

    Clients -->|1. Browse & Click 'Download'| SDS
    SDS -->|2. Pull stream from Real-Debrid / TorBox| Disk
    Disk -->|3. Gigabit LAN Direct Play (0 Internet)| Clients
    CF -.->|4. Remote HTTPS Playback (Away from home)| Clients
```

---

## ⚡ Quick Start: 24/7 Home Server (Recommended)

Run Stremio-Local-Media-Server 24/7 on an always-on server, Raspberry Pi, or mini-PC (Ubuntu/Debian/Arch Linux with Docker).

### 1. Clone & Configure

```bash
git clone https://github.com/CedricS789/stremio-local-media-server.git ~/stremio-dock/app
cd ~/stremio-dock/app
cp .env.example .env
```

Edit `.env` with your preferred settings:

```env
# Path to store your downloaded media on the host
MEDIA_ROOT=/home/your-user/stremio-dock

# Admin credentials & random secrets
NUVI_ADMIN_PASSWORD=your_secure_password
NUVI_SESSION_SECRET=random_32_byte_string
NUVI_STREAM_SECRET=random_32_byte_string

# Your private AIOStreams manifest URL (without /manifest.json)
AIOSTREAMS_BASE_URL=https://aiostreams.example.com/stremio/your-uuid

# Storage allocation limit in GB (verified before downloads start)
MEDIA_ALLOCATED_LIMIT_GB=100
```

### 2. Launch the Container

```bash
docker compose up -d --build
```

Verify that the service is running:
* **Health Check:** `http://<server-ip>:60500/health`
* **Downloads & Storage Dashboard:** `http://<server-ip>:60500/downloads`

### 3. Install in Stremio

1. Open your admin dashboard at `http://<server-ip>:60500/admin` (Log in with `admin` and your password).
2. Copy your manifest URL (looks like `http://<server-ip>:60500/addon/<token>/manifest.json`).
3. In **Stremio**, go to the **Addons** tab, paste the manifest URL into the search box, and click **Install**.

> **Tip for Multi-Device & iPhone (HTTPS):**  
> If using Cloudflare Tunnel, map `dock.yourdomain.com` → `http://dock-origin:60500`. Your manifest URL becomes `https://dock.yourdomain.com/addon/<token>/manifest.json`. Once installed, Stremio automatically syncs it across your PC, iPhone, iPad, and TV! See the **[Home Server Deployment Guide](docs/HOMESERVER_DEPLOYMENT_GUIDE.md)** for full details.

---

## 💻 Desktop Workstation Setup (Windows 10/11 + WSL 2)

If you prefer to run Stremio-Local-Media-Server locally on your main PC:

1. Ensure **WSL 2 with Ubuntu** and Docker Engine are installed.
2. Clone the repository in PowerShell:
   ```powershell
   git clone https://github.com/CedricS789/stremio-local-media-server.git
   cd stremio-local-media-server
   ```
3. Run the setup helper:
   ```powershell
   .\scripts\Initialize.ps1 -MediaRoot "C:\StremioMedia"
   ```
4. Build and start via Docker:
   ```bash
   wsl -d Ubuntu-24.04 -e bash -c "cd /mnt/c/path/to/stremio-local-media-server && docker compose up -d --build"
   ```
5. *(Optional)* Install the background watcher that automatically turns on Docker when Stremio opens and cleanly stops it only after active downloads finish:
   ```powershell
   .\scripts\Install-Lifecycle.ps1
   ```

---

## 📱 Mobile Device Guide (iPhone & iPad)

Because iOS Safari does not natively decode `.mkv` containers or `VC-1` codecs:

1. **Install PWA:** Open `https://web.stremio.com` in Safari, tap **Share** → **Add to Home Screen**.
2. **External Player:** In Stremio Web, go to **Settings (Gear icon) → Streaming**, and set **Play in external player** to **Outplayer** or **VLC** (free in the App Store).
3. **1-Click Downloading:** Clicking **"⬇️ Download Season"** on your iPhone sends the download job directly to your server. Your phone uses **zero battery and zero storage** downloading large files.
4. **Playback:**
   * **At Home:** Tap **`🏠 LAN Direct`** (100% Gigabit local Wi-Fi, 0 MB internet data used).
   * **Away from Home:** Tap **`🌐 Remote`** to stream over cellular data without a VPN.

---

## 🗂️ Architecture & Project Structure

```text
stremio-local-media-server/
├── cards/                  # HTML5/JS Live Downloads Dashboard & Interactive Source Selector
│   ├── choose.html         # Quality, resolution, and episode selection modal
│   └── downloads.html      # Storage stats, active download progress bars & 1-click delete
├── docs/                   # Architectural guides & deployment blueprints
│   ├── HOMESERVER_DEPLOYMENT_GUIDE.md # Production Linux server setup
│   └── PLAYBACK_ROADMAP.md # Future player & protocol specifications
├── scripts/                # Automations & setup utilities
│   ├── check-media-space.sh # 15-minute cron storage monitor
│   ├── Initialize.ps1      # Windows/WSL environment generator
│   └── stremio_lifecycle.py# Automated Windows process observer
├── src/                    # TypeScript backend source code
│   ├── routes/stremio.ts   # Core Stremio addon manifest, catalog, stream & download engine
│   ├── routes/media.ts     # Range-capable HTTP media streaming server
│   ├── routes/admin.ts     # System administration & settings endpoints
│   ├── services/scanner.ts # Local media file matcher (Cinemeta & TMDB fallback)
│   └── server.ts           # Fastify server entrypoint
├── compose.yaml            # Docker Compose production configuration
├── Dockerfile              # Multi-stage optimized Node.js runtime image
└── package.json            # Node.js manifest & dependencies
```

---

## 🔒 Security & Privacy

* **Zero Open Router Ports:** When paired with Cloudflare Tunnel, no ports are forwarded on your router. Your home IP address is completely shielded.
* **Token Protection:** Stremio manifests and stream URLs require a 43-character high-entropy cryptographic token (`/addon/<token>/...`). Unauthorized requests return `404 Not Found`.
* **Container Isolation:** The container runs under an unprivileged `node` user (UID 1000) and only accesses the mounted `/media` directory. Path traversal attempts are strictly sanitized.

---

## 🤝 Attribution & Open Source

Stremio-Local-Media-Server is proudly built upon foundational work from:
* [riverflow-media/nuvi-flow](https://github.com/riverflow-media/nuvi-flow)
* [Squipy411/personal-media-addon](https://github.com/Squipy411/personal-media-addon)

All original notices and MIT licenses are preserved in [FORK_NOTICE.md](FORK_NOTICE.md), [LICENSE](LICENSE), and [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md).
