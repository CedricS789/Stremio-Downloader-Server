# My-Media-Dock — Custom Integration & Scripts

This directory contains the customized Windows, WSL, and Stremio integration files used alongside Nuvi-Flow (pinned to upstream commit `bb4e694070923a9ca6fec4305aa01d06a677a9b2`). It adds a customized Stremio stream selection route, local downloads dashboard, and optional Windows lifecycle automation.

## Key Components

- `compose.yaml`: Runs the pinned Nuvi-Flow container with `nuviflow-stremio.js` mounted over the compiled route and `cards/` mounted into the container. Pre-configured to bind securely to `127.0.0.1:60500:60500`.
- `Initialize.ps1`: Optional helper script to create media directories (`media/movies`, `media/tv`) and generate a `.env` file with secure random secrets and properly formatted WSL paths.
- `.env.example`: Template configuration file for users who prefer configuring `.env` manually with File Explorer and any text editor.
- `lifecycle-settings.json`: Pre-configured settings file for the background lifecycle watcher.
- `stremio_lifecycle.py`: Background watcher that starts Docker/WSL when Stremio opens and waits for ongoing downloads and library scans to drain safely before stopping the containers. Dynamically detects its working directory and converts paths to WSL format on any drive.
- `Install-Lifecycle.ps1`: Registers the lifecycle watcher as a Windows scheduled task or startup entry. Automatically locates `pythonw.exe` from `PATH` or standard installation directories, or accepts `-PythonPath`.
- `Remove-Lifecycle.ps1`: Removes the scheduled task and startup entry cleanly.

## Path Flexibility

All scripts and services can be kept in any directory on any drive (e.g. inside the cloned repository, or in a dedicated tools folder). Downloaded media can also be stored on any local drive or partition.
