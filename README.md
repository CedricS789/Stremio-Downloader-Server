# My-Media-Dock

A personal, unofficial Windows and Stremio integration for choosing a stream from AIOStreams, downloading it to a local media library, and serving matching local files directly in Stremio as local sources and catalogues. It is not affiliated with Stremio, AIOStreams, Real-Debrid, or TorBox.

> **Status:** This is a customized setup built on top of [riverflow-media/nuvi-flow](https://github.com/riverflow-media/nuvi-flow). Local playback and downloads are supported, but provider availability depends on your own configured debrid and AIOStreams services. Always use content you have the right to access. The original upstream documentation and licensing are preserved in [FORK_NOTICE.md](FORK_NOTICE.md), [LICENSE](LICENSE), and [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md).

---

## Flexibility & Principles

- **Place it anywhere:** You can keep this project in any directory on any drive (directly in the cloned repository's `custom` folder, or in a separate folder such as `C:\StremioAutomation` or `D:\Tools\My-Media-Dock`). The scripts and watcher dynamically resolve their location and map Windows paths to WSL automatically.
- **Store media anywhere:** You can store downloaded media on any local drive or partition (`C:\StremioMedia`, `D:\Media`, `E:\Videos`, etc.).
- **Use standard Windows tools:** You do not need PowerShell for basic Windows file operations. Creating folders, moving files, and editing configurations can all be done using standard Windows File Explorer and your preferred text editor (Notepad, VS Code, etc.). PowerShell is only needed if you choose to run the optional helper automation scripts (`Initialize.ps1` / `Install-Lifecycle.ps1`).

---

## What You Need

1. **Windows 10/11** with [Stremio](https://www.stremio.com/) and [Git for Windows](https://git-scm.com/install/windows).
2. **WSL 2 with Ubuntu** (e.g. Ubuntu 24.04) and Docker Engine + Docker Compose plugin installed inside Ubuntu.
3. **An x86-64 PC** with internet access and sufficient free disk space for media downloads.
4. **An AIOStreams configuration** (optional, but recommended if you want to select and download debrid streams from within Stremio).
5. **Python 3 on Windows** (optional, only required if you use the automatic start/stop background watcher).

---

## Step-by-Step Setup

### 1. Verify WSL 2 and Ubuntu

Ensure WSL 2 with Ubuntu is installed on your Windows system. In any terminal (Command Prompt or PowerShell):

```text
wsl --list --verbose
```

- If `Ubuntu-24.04` (or another Ubuntu distribution) is listed with version `2`, it is ready.
- If Ubuntu is not yet installed, install it from an administrator terminal:
  ```text
  wsl --install -d Ubuntu-24.04
  ```
  Follow the on-screen prompt to create your Linux username and password.

---

### 2. Verify Docker Engine inside Ubuntu

Open your Ubuntu distribution:

```text
wsl -d Ubuntu-24.04
```

Check that Docker and Docker Compose are installed and running inside Linux:

```bash
docker --version
docker compose version
docker info
```

If Docker is not yet installed inside your Ubuntu WSL distribution, follow [Docker's official Ubuntu installation guide](https://docs.docker.com/engine/install/ubuntu/). To allow non-root access without `sudo`, ensure your user is added to the docker group:

```bash
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

---

### 3. Get the Project Files

Clone the repository to any directory of your choice using Git in your preferred terminal or Git GUI:

```bash
git clone https://github.com/CedricS789/My-Media-Dock.git
```

The core integration files live in the **`custom`** folder. You have two options for where to keep them:
- **Option A (Keep in repo):** Run directly from inside the `custom` folder of the cloned repository.
- **Option B (Separate folder):** In File Explorer, copy the contents of `custom` to any dedicated directory you prefer (for example, `C:\StremioAutomation` or `D:\Apps\My-Media-Dock`).

---

### 4. Configure Your Media Folder & Environment

You need a `.env` file in your project folder and a folder on your computer to store downloaded videos. You can do this automatically or manually:

#### Option 4A: Using the Helper Script (PowerShell)
Open PowerShell in your project directory and run:

```powershell
.\Initialize.ps1 -MediaRoot "C:\StremioMedia"
```
*(Replace `"C:\StremioMedia"` with any path on any drive, such as `"D:\Media"`).*

This script:
1. Creates the movie and TV subfolders on disk.
2. Formats the path for WSL automatically (e.g., `C:\StremioMedia` becomes `/mnt/c/StremioMedia`).
3. Generates strong, random secrets for `NUVI_ADMIN_PASSWORD`, `NUVI_SESSION_SECRET`, and `NUVI_STREAM_SECRET`.
4. Saves them into a new `.env` file.

#### Option 4B: Manual Setup (File Explorer & Notepad)
If you prefer not using PowerShell:
1. In File Explorer, create your desired media folder (e.g. `C:\StremioMedia` or `D:\Media`), and create two subfolders inside it: `media\movies` and `media\tv`.
2. In your project folder, copy `.env.example` and rename it to `.env`.
3. Open `.env` in Notepad and set `MEDIA_ROOT` to the WSL path of your folder (e.g. `/mnt/c/StremioMedia` or `/mnt/d/Media`), then set your own random passwords for the secret keys.

---

### 5. Add Your AIOStreams Connection (Optional)

If you use AIOStreams with your debrid account:
1. Open `.env` in Notepad or your preferred text editor.
2. Set `AIOSTREAMS_BASE_URL` to your configured AIOStreams URL **without the trailing `/manifest.json`**:
   ```text
   AIOSTREAMS_BASE_URL=https://aiostreams.example.com/your-private-uuid
   ```
3. Save and close the file. Keep this URL private as it contains your private debrid token.

---

### 6. Start the Service

`compose.yaml` is already pre-configured to bind securely to `127.0.0.1:60500:60500`, preventing unwanted external exposure.

Open your Ubuntu WSL terminal and navigate to your project directory (replace with your actual path):

```bash
cd /mnt/c/path/to/your/custom-folder
```

Create the Docker persistent configuration volume and start the container:

```bash
docker volume create stremio-automation_nuvi_config
docker compose pull
docker compose up -d
docker compose ps
```

The container will show as `Up`. Verify by opening [http://localhost:60500/health](http://localhost:60500/health) in your browser.

---

### 7. Install the Addon in Stremio

1. Open your web browser and go to the admin dashboard: [http://localhost:60500/admin](http://localhost:60500/admin).
2. Log in with username **`admin`** and the password from your `.env` file (`NUVI_ADMIN_PASSWORD`).
3. Navigate to **Settings** and copy the **Nuvio addon manifest URL** (this is Stremio-compatible, e.g. `http://localhost:60500/manifest.json?...`).
4. In the Stremio desktop app, open **Add-ons**, paste the copied URL into the search bar, and install **My-Media-Dock**.

---

### 8. Test Downloads and Local Playback

1. In Stremio, open any movie or TV series episode.
2. In the stream source list, look for the **My-Media-Dock** stream option.
3. Selecting it opens the source-selection screen. Choose a downloadable stream.
4. Check download progress anytime at [http://localhost:60500/downloads](http://localhost:60500/downloads).
5. Once the download and automatic library scan finish, reopen the title in Stremio to see the local direct-play source and check the **My-Media-Dock - Downloaded** catalog.

---

### 9. Optional: Automatic Startup & Safe Shutdown with Stremio

A background Python watcher is included that automatically starts the WSL Docker container when you open Stremio, and when you close Stremio, waits for active downloads and library imports to finish before stopping the container.

- **Pre-configured settings:** `lifecycle-settings.json` is included in the project folder with default settings. You can open and adjust it in Notepad if you use a different WSL distribution name or want different polling intervals.
- **Python requirement:** Any standard Python 3 installation on Windows. The installer automatically discovers `pythonw.exe` from your `PATH` or standard Windows install locations.

To enable the watcher, open PowerShell in your project directory and run:

```powershell
.\Install-Lifecycle.ps1
```

*(If Python is in a non-standard location, you can pass `.\Install-Lifecycle.ps1 -PythonPath "C:\Path\To\pythonw.exe"`).*

To disable and remove the watcher at any time, run:

```powershell
.\Remove-Lifecycle.ps1
```

---

### 10. Manual Management

If you prefer to control the service manually without background automation:

- **Start:** In Ubuntu WSL:
  ```bash
  cd /mnt/c/path/to/custom-folder
  docker compose up -d
  ```
- **Stop:** In Ubuntu WSL (wait until any active downloads complete):
  ```bash
  cd /mnt/c/path/to/custom-folder
  docker compose stop
  ```

---

## Security & Attribution

- **Local binding:** Services bind to `127.0.0.1` by default. Do not expose this service to the public internet without proper authentication and reverse-proxy protection.
- **Credentials:** Keep your `.env` file private and never commit it to Git.
- **Attribution:** Built on [riverflow-media/nuvi-flow](https://github.com/riverflow-media/nuvi-flow) and [Squipy411/personal-media-addon](https://github.com/Squipy411/personal-media-addon). All original licenses and attribution notices are preserved.
