# My-Media-Dock

This directory preserves the custom integration used alongside Nuvi-Flow upstream commit `bb4e694070923a9ca6fec4305aa01d06a677a9b2`. It adds a customized Stremio route, download and source-selection pages, and Windows lifecycle scripts. The downloaded catalogue is named **My-Media-Dock - Downloaded**.

The Compose file uses the pinned upstream container image and mounts `nuviflow-stremio.js` over its compiled route and `cards/` into the container. The upstream TypeScript source in the rest of this repository does not contain these changes; rebuilding it alone does not produce the custom behavior. The override is coupled to the pinned image and must be reviewed before upgrading it.

## Windows runtime choice

This guide uses **Docker Engine installed directly inside an Ubuntu WSL distribution**. The original lifecycle watcher assumes the distribution is named `Ubuntu-24.04`, Docker is managed by systemd inside WSL, and the integration is located at `C:\StremioAutomation`. These are requirements of the current scripts, not a verified installation procedure for a fresh machine. The watcher also assumes `C:\Python312\pythonw.exe`. Check and adapt these assumptions before installing the lifecycle task.

`Initialize.ps1` creates a local `.env` and media directories. The lifecycle scripts are specific to the original Windows/WSL setup and may require adaptation; this is a backup of the working customization, not a tested installer for another machine. Provider connections and the optional AIOStreams URL must be configured separately.

Private configuration, credentials, databases, downloaded media and logs are intentionally excluded. Keep `.env` and personal settings out of Git.
