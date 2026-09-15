# Stremio Sense for Windows

Stremio Sense keeps the **official Stremio Windows installation** intact and adds a local companion for native downloads.

## What the bundle contains

- `stremio-sense-agent.exe` — loopback-only companion on `127.0.0.1:11471`
- `launch-sense.ps1` — starts the companion and then launches the installed official `stremio.exe` with the bundled Sense Web UI
- `web-ui/` — the tested Sense Web build

The official Stremio updater remains responsible for `stremio.exe`, the player, and Stremio's streaming server. Sense does not patch those files.

## Run

1. Install/update official Stremio normally.
2. Extract the Sense Windows ZIP somewhere permanent.
3. Right-click `launch-sense.ps1` and choose **Run with PowerShell**, or run:

```powershell
powershell -ExecutionPolicy Bypass -File .\launch-sense.ps1
```

The launcher starts official Stremio with:

```text
--webui-url=http://127.0.0.1:11471/ui/
```

The companion serves the bundled UI locally, so GitHub Pages or an internet-hosted Sense UI is not required to launch the app.

## Downloads

Default location:

```text
%USERPROFILE%\Videos\Stremio Sense
```

Choose another directory when launching:

```powershell
.\launch-sense.ps1 -DownloadDir 'D:\Stremio Downloads'
```

Downloads are ordinary files on disk. The companion persists metadata, supports HTTP Range resume, continues downloads after the Stremio window closes, and provides local Range playback to the Downloads screen.

If the companion is not available and Sense Web is opened separately in a compatible browser, the Web download manager falls back to OPFS browser storage.

## Updates

There are deliberately separate update paths:

- **Official Stremio:** unchanged; use Stremio's normal updater.
- **Sense Web + companion:** download the newest `stremio-sense-windows.zip` release and replace this Sense folder.
- **Upstream Web compatibility:** the Sense branch checks Stremio Web `development` daily. Clean upstream changes are tested/built before being merged. Conflicting upstream changes are not applied; an issue is opened and the last validated Sense build remains intact.

## Security

The companion binds to `127.0.0.1` only by default. Do not expose port `11471` to your LAN or the public internet.
