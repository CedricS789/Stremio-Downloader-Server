# My-Media-Dock

A self-hosted, personal Stremio media server and download dock. It lets you select streams from AIOStreams, download them directly to your local storage, and stream them locally in Stremio with rich playback metadata and library catalogs.

> **Status:** Built and customized on top of [riverflow-media/nuvi-flow](https://github.com/riverflow-media/nuvi-flow) and [Squipy411/personal-media-addon](https://github.com/Squipy411/personal-media-addon). All original notices and MIT licenses are preserved in [FORK_NOTICE.md](FORK_NOTICE.md), [LICENSE](LICENSE), and [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md).

---

## Highlights

- **100% Self-Contained:** Builds locally from this repository (`docker compose up --build`). No dependency on third-party pre-built container registries.
- **In-Stremio Downloads:** Select streams from your configured AIOStreams/Debrid provider directly from Stremio stream results.
- **Live Downloads Dashboard:** Monitor download progress, speed, storage usage, and library sync at `http://localhost:60500/downloads`.
- **Local Media Playback:** Automatically matches downloaded media with Cinemeta metadata and serves local direct-play streams.
- **Location & Drive Flexible:** Run the repository from any directory, and store your media library on any drive or partition (`C:\`, `D:\`, etc.).
- **Optional Background Watcher:** Automatically starts the Docker service when Stremio opens and cleanly stops it only after active downloads finish.

---

## Requirements

1. **Windows 10/11** with [Stremio](https://www.stremio.com/) and [Git](https://git-scm.com/install/windows).
2. **WSL 2 with Ubuntu** (e.g. `Ubuntu-24.04`) and Docker Engine + Docker Compose installed inside Ubuntu.
3. **An AIOStreams configuration** (with your Real-Debrid or TorBox account configured).
4. **Python 3 on Windows** (optional, only required if you use the automatic start/stop background watcher).

---

## Quick Setup

### 1. Verify WSL 2 & Docker Engine

Ensure Ubuntu is running on WSL 2 and Docker Engine is active inside Linux:

```bash
# In Windows terminal:
wsl --list --verbose

# Enter Ubuntu WSL:
wsl -d Ubuntu-24.04

# Inside Ubuntu:
docker --version
docker compose version
```

---

### 2. Clone the Repository

Clone this repository to anywhere on your computer:

```bash
git clone https://github.com/CedricS789/My-Media-Dock.git
cd My-Media-Dock
```

---

### 3. Configure Your Media Folder & Environment

You need a `.env` file in the repository root. You can generate it with the helper script or create it manually:

#### Option A: Using the PowerShell Helper
In PowerShell from the repository root:

```powershell
.\scripts\Initialize.ps1 -MediaRoot "C:\StremioMedia"
```
*(Replace `"C:\StremioMedia"` with any path on any drive, such as `"D:\Media"`).*

This creates the media folders, formats the WSL mount path, generates random secrets, and writes `.env`.

#### Option B: Manual Setup (File Explorer & Notepad)
1. Create your media folder (e.g., `C:\StremioMedia` or `D:\Media`) with two subfolders: `media\movies` and `media\tv`.
2. Copy `.env.example` to `.env` in the repository root.
3. Open `.env` in Notepad and set `MEDIA_ROOT` to the WSL path (e.g., `/mnt/c/StremioMedia` or `/mnt/d/Media`), and set your admin password.

---

### 4. Add Your AIOStreams URL (Optional)

Open `.env` in any text editor and add your configured AIOStreams private manifest URL without the trailing `/manifest.json`:

```text
AIOSTREAMS_BASE_URL=https://aiostreams.example.com/your-private-uuid
```

---

### 5. Build and Start the Docker Container

In your Ubuntu WSL terminal, navigate to the repository directory and build:

```bash
cd /mnt/c/path/to/My-Media-Dock
docker volume create stremio-automation_nuvi_config
docker compose up --build -d
docker compose ps
```

Docker will compile the TypeScript source, bake the cards into the image, and start the container. Verify it is running at [http://localhost:60500/health](http://localhost:60500/health).

---

### 6. Install the Addon in Stremio

1. Open your browser and go to the admin dashboard: [http://localhost:60500/admin](http://localhost:60500/admin) (Log in with `admin` and your password from `.env`).
2. Go to **Settings** and click **Copy manifest URL** (it looks like `http://127.0.0.1:60500/addon/<token>/manifest.json`).
3. In the Stremio desktop app:
   - Click the **puzzle piece icon** (🧩 **Add-ons**) on the left sidebar.
   - Paste the manifest URL into the search bar at the top and press **Enter**.
   - Click the green **Install** button on the **My-Media-Dock** card.

---

### 7. Test Downloads & Playback

1. In Stremio, open any movie or series episode.
2. In the stream list, select the **⚡ My-Media-Dock** option.
3. Choose a downloadable stream from the interactive source-picker.
4. Monitor active downloads at [http://localhost:60500/downloads](http://localhost:60500/downloads).
5. Once complete, reopen the title to play directly from local storage, or browse the **My-Media-Dock - Downloaded** catalog in Stremio.

---

### 8. Optional: Automatic Startup & Safe Shutdown with Stremio

To automatically launch Docker when Stremio opens and safely wait for downloads to finish before stopping:

1. Review `scripts/lifecycle-settings.example.json` if you wish to customize timing or distro.
2. In PowerShell from the repository root:
   ```powershell
   .\scripts\Install-Lifecycle.ps1
   ```
   *(If Python is in a custom path, you can specify `.\scripts\Install-Lifecycle.ps1 -PythonPath "C:\Path\To\pythonw.exe"`).*

To remove the background task at any time:
```powershell
.\scripts\Remove-Lifecycle.ps1
```

---

## Repository Structure

```text
My-Media-Dock/
├── cards/                  # Interactive source selector and live downloads UI
├── scripts/                # Setup & Windows lifecycle automation scripts
│   ├── Initialize.ps1      # Generates .env and creates media directories
│   ├── Install-Lifecycle.ps1 # Registers automatic startup task in Windows
│   ├── Remove-Lifecycle.ps1  # Unregisters automatic startup task
│   └── stremio_lifecycle.py # Background process observer and download drain
├── src/                    # TypeScript backend source code
│   ├── routes/stremio.ts   # Core Stremio & AIOStreams download endpoints
│   ├── server.ts           # Fastify server entrypoint
│   └── ...
├── .env.example            # Environment configuration template
├── compose.yaml            # Docker Compose configuration (builds from source)
├── Dockerfile              # Multi-stage production build definition
└── package.json            # Node.js project manifest and build scripts
```

---

## Security & Attribution

- **Local binding:** Services bind to `127.0.0.1` by default. Do not expose this service to the public internet without proper authentication.
- **Credentials:** Keep `.env` private and never commit it to Git.
- **Attribution:** Built on [riverflow-media/nuvi-flow](https://github.com/riverflow-media/nuvi-flow) and [Squipy411/personal-media-addon](https://github.com/Squipy411/personal-media-addon).
