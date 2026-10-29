# My-Media-Dock

A personal, unofficial Windows and Stremio integration for choosing a source from AIOStreams, downloading it to a local media library, and presenting matching local files as Stremio sources and catalogues. It is not affiliated with Stremio, AIOStreams, Real-Debrid, or TorBox.

**Status:** this is a customized setup, not a packaged installer. Local playback and one download were previously demonstrated, but this guide and its automatic lifecycle have not been verified end to end on a clean machine. Provider compatibility depends on the URLs returned by your AIOStreams configuration. Use content you are entitled to access.

The integration runs a pinned Nuvi-Flow container with a replacement compiled route and custom pages mounted over it. The upstream TypeScript code alone does not build these custom features. Keep the image pinned: upgrading it independently can break the override. The upstream project and its license remain credited in [FORK_NOTICE.md](FORK_NOTICE.md), [LICENSE](LICENSE), and [the original documentation](docs/UPSTREAM-README.md).

## What you need

- Windows 10/11 with Stremio and [Git for Windows](https://git-scm.com/install/windows).
- Ubuntu 24.04 running in WSL 2, with Docker Engine and the Docker Compose plugin installed **inside Ubuntu**.
- An x86-64 PC, internet access, and enough free local disk space. The pinned image is configured for `linux/amd64`.
- A working AIOStreams configuration that can return downloadable HTTP(S) streams. Configure your own provider accounts there. No provider account or credentials are included.
- For optional automatic startup and shutdown: Python 3.12 with `C:\Python312\pythonw.exe`. The scripts currently assume this exact path.

The download UI, local add-on URL, and lifecycle scripts assume Stremio runs on the same PC as the service. They do not automatically download everything you follow. CrossWatch is not required.

## 1. Install Ubuntu 24.04 on WSL 2

In **PowerShell**, check existing distributions:

```powershell
wsl --list --verbose
```

If `Ubuntu-24.04` is present and its version is 2, use it. Otherwise, run the following in **PowerShell as administrator** and restart if requested:

```powershell
wsl --install -d Ubuntu-24.04
```

Launch Ubuntu, create its Linux user and password, then verify `wsl --list --verbose` again. If the distribution name differs, the lifecycle script must be adapted before use. See [Microsoft's WSL installation guide](https://learn.microsoft.com/windows/wsl/install).

## 2. Install and verify Docker Engine inside Ubuntu

From PowerShell:

```powershell
wsl -d Ubuntu-24.04
```

The following commands are entered at the **Ubuntu** prompt:

```bash
ps -p 1 -o comm=
docker --version
docker compose version
systemctl is-active docker
```

PID 1 should be `systemd`. If Docker and Compose are already installed and Docker is active, skip to step 3. If systemd is not enabled, follow [Microsoft's systemd instructions](https://learn.microsoft.com/windows/wsl/systemd/). Restarting WSL affects all running WSL workloads; do not do it during active work.

For a fresh Ubuntu installation without Docker, follow [Docker's official Ubuntu Engine installation instructions](https://docs.docker.com/engine/install/ubuntu/) using the **apt repository** method. Check that no conflicting packages or existing workloads will be disrupted before making changes. Then start Docker:

```bash
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Exit Ubuntu, open a new Ubuntu session, and confirm that these run **without sudo**:

```bash
docker info
docker compose version
```

The lifecycle watcher needs noninteractive access. Docker group membership provides root-level control over the Linux environment; understand that trade-off before enabling it. See [Docker's post-installation guide](https://docs.docker.com/engine/install/linux-postinstall/).

## 3. Download the project and copy the integration

Open a new **PowerShell** window. For a public repository, clone without signing in:

```powershell
cd "$HOME\Documents"
git clone https://github.com/CedricS789/My-Media-Dock.git
Copy-Item "$HOME\Documents\My-Media-Dock\custom" C:\StremioAutomation -Recurse
```

If a destination already exists, inspect it first; do not overwrite an existing installation. The watcher currently requires exactly `C:\StremioAutomation`. The directory should contain `compose.yaml`, `Initialize.ps1`, `nuviflow-stremio.js`, `stremio_lifecycle.py`, and `cards`.

## 4. Create configuration and media directories

In PowerShell:

```powershell
cd C:\StremioAutomation
.\Initialize.ps1 -MediaRoot "C:\StremioMedia"
```

If execution policy blocks the script, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\Initialize.ps1 -MediaRoot "C:\StremioMedia"
```

This creates local movie and TV folders and a `.env` containing generated secrets. It refuses to overwrite an existing `.env`. Back up that file securely and never commit it or share its contents.

The initializer writes a Windows path; Docker runs inside WSL. Open `C:\StremioAutomation\.env` with Notepad and change **only** the media path to:

```text
MEDIA_ROOT=/mnt/c/StremioMedia
```

If you chose another drive or directory, use its correct WSL path instead, for example `D:\Media` becomes `/mnt/d/Media`.

## 5. Configure AIOStreams

Configure your own AIOStreams instance and provider accounts separately. In `.env`, add the private configured addon URL **without the final `/manifest.json`**:

```text
AIOSTREAMS_BASE_URL=https://example.invalid/your-configured-addon
```

Replace the example with the real base URL, without exposing it in screenshots, issue reports, or Git. The service requests `/stream/<type>/<id>.json` below this base. A working HTTP(S) URL must be reachable from **inside the container**; `localhost` there points to the container, not Windows. An instance on the PC needs a container-reachable address. This project does not set up AIOStreams or guarantee every debrid result is downloadable.

## 6. Bind the service locally

Open `C:\StremioAutomation\compose.yaml`. Under `ports`, replace:

```yaml
      - "60500:60500"
```

with:

```yaml
      - "127.0.0.1:60500:60500"
```

Save it. The custom download endpoints are intended for a trusted local environment. Do not expose them or the private addon URL to the public internet. The repository is public-ready; this does not make a running instance safe to publish.

## 7. Start the service

From PowerShell:

```powershell
wsl -d Ubuntu-24.04
```

In Ubuntu:

```bash
sudo systemctl start docker
cd /mnt/c/StremioAutomation
docker volume create stremio-automation_nuvi_config
docker compose pull
docker compose up -d
docker compose ps
```

The Nuvi-Flow container should report running. Check [http://localhost:60500/health](http://localhost:60500/health), then open [http://localhost:60500/admin](http://localhost:60500/admin).

The initial username is `admin`; its generated password is the value of `NUVI_ADMIN_PASSWORD` in `C:\StremioAutomation\.env`. The persistent volume contains the service's library and settings. Do not remove it during an ordinary restart.

If startup fails, run `docker compose logs --tail=100 nuviflow` in Ubuntu. Logs can contain sensitive URLs; redact them before sharing.

## 8. Install the add-on

1. In the admin dashboard, open **Settings**.
2. Copy the **Nuvio addon manifest URL**. This is the upstream label for the Stremio-compatible manifest.
3. In Stremio, open **Add-ons**, paste the URL into the add-on search field, and install **My-Media-Dock**.
4. Keep the URL private: it contains an access token.

The default URL uses `localhost`, so it works on the computer running the service. Another device's `localhost` refers to itself; remote playback requires separate networking and security design.

## 9. Test local downloads and playback

1. Select a movie or episode in Stremio and look for the My-Media-Dock download option in its sources.
2. Choose a small downloadable HTTP(S) source. Use [the downloads page](http://localhost:60500/downloads) to check progress.
3. Wait for the download and library scan to complete.
4. Reopen the title in Stremio and check its local source and the **My-Media-Dock - Downloaded** catalogue.

If the source page cannot load, verify the AIOStreams base URL, provider availability, container network reachability, and logs. A source that plays in an add-on is not necessarily a directly downloadable URL. Fresh-install compatibility, individual providers, catalogue matching, and restart recovery are not yet comprehensively tested.

## 10. Optional: start and stop with Stremio

Complete the manual test first. The included Windows watcher is intended to start the service when Stremio opens and wait for active downloads and library scans after Stremio closes. This behavior is **not yet validated on a clean installation**, and shutdown, sleep, power loss, or killing WSL can interrupt work. Test with a small download before relying on it.

The installer assumes `Ubuntu-24.04`, `C:\StremioAutomation`, and `C:\Python312\pythonw.exe`. It registers a Windows scheduled task or startup entry, and it removes an existing Docker Desktop sign-in entry after backing it up. Read `Install-Lifecycle.ps1` before running it if other Docker workloads matter.

In PowerShell, verify Python:

```powershell
Test-Path C:\Python312\pythonw.exe
```

If this returns `False`, install Python at that path or adapt the installer first. Then create settings:

```powershell
@'
{
  "useWsl": true,
  "wslDistro": "Ubuntu-24.04",
  "dockerExecutable": "wsl.exe",
  "pollSeconds": 2,
  "drainCheckSeconds": 15,
  "quietSeconds": 90,
  "librarySyncSeconds": 3600,
  "stopDockerWhenUnused": false,
  "preventSleepWhileDraining": true
}
'@ | Set-Content C:\StremioAutomation\lifecycle-settings.json -Encoding utf8
cd C:\StremioAutomation
.\Install-Lifecycle.ps1
```

Open Stremio and confirm startup. Begin a small download, close Stremio while it runs, and verify it completes and the library scan finishes before the container stops. Reopen Stremio and verify restart. Check `C:\StremioAutomation\logs\lifecycle.log` and `docker compose ps` in Ubuntu if needed. If the test fails, leave the service running manually and diagnose before relying on automatic shutdown.

## Manual operation and removal

From Ubuntu:

```bash
cd /mnt/c/StremioAutomation
docker compose up -d
docker compose ps
docker compose stop
```

Stop only after downloads finish. `wsl --shutdown` stops all WSL distributions and interrupts their work.

To remove automatic lifecycle control, run `C:\StremioAutomation\Remove-Lifecycle.ps1` in PowerShell. Uninstall the add-on from Stremio separately. Removing the container, its persistent volume, settings, or media is a separate destructive action; preserve anything you want to keep.

## Privacy and attribution

Media matching can contact metadata services; AIOStreams and your configured providers receive requests necessary to retrieve sources. Your media, passwords, databases, account data, provider keys, and manifest URLs are not included in this repository.

My-Media-Dock contains a customized integration built on [riverflow-media/nuvi-flow](https://github.com/riverflow-media/nuvi-flow), itself based on [Squipy411/personal-media-addon](https://github.com/Squipy411/personal-media-addon). Their notices and MIT license are retained. Upstream files and scripts can still use the Nuvi-Flow name.
