param(
    [Parameter(Mandatory = $false)]
    [string]$WebUiUrl = $(if ($env:SENSE_WEBUI_URL) { $env:SENSE_WEBUI_URL } else { 'http://127.0.0.1:11471/ui/' }),

    [Parameter(Mandatory = $false)]
    [string]$StremioExe,

    [Parameter(Mandatory = $false)]
    [string]$AgentExe,

    [Parameter(Mandatory = $false)]
    [string]$DownloadDir
)

$ErrorActionPreference = 'Stop'

# Parameter default expressions are evaluated before $PSScriptRoot is reliably
# available on Windows PowerShell 5.1. Resolve paths only after param binding.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptDir) {
    $ScriptDir = (Get-Location).Path
}
if (-not $AgentExe) {
    $AgentExe = Join-Path $ScriptDir 'stremio-sense-agent.exe'
}

function Find-StremioExe {
    param([string]$ExplicitPath)

    if ($ExplicitPath) {
        if (Test-Path -LiteralPath $ExplicitPath) {
            return (Resolve-Path -LiteralPath $ExplicitPath).Path
        }
        throw "Stremio executable not found at: $ExplicitPath"
    }

    $command = Get-Command stremio.exe -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Stremio\stremio.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\LNV\Stremio-4\stremio.exe'),
        (Join-Path $env:ProgramFiles 'Stremio\stremio.exe'),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Stremio\stremio.exe' })
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

    if ($candidates.Count -gt 0) {
        return (Resolve-Path -LiteralPath $candidates[0]).Path
    }

    throw 'Could not find the official Stremio installation. Reinstall official Stremio or pass -StremioExe with its full path.'
}

function Test-SenseAgent {
    try {
        $result = Invoke-RestMethod -Uri 'http://127.0.0.1:11471/v1/health' -TimeoutSec 1
        return [bool]$result.ok
    }
    catch {
        return $false
    }
}

if (-not (Test-Path -LiteralPath $AgentExe)) {
    throw "Sense companion not found at: $AgentExe"
}

if (-not (Test-SenseAgent)) {
    if ($DownloadDir) {
        Start-Process -FilePath $AgentExe -ArgumentList @('--download-dir', $DownloadDir) -WindowStyle Hidden
    }
    else {
        Start-Process -FilePath $AgentExe -WindowStyle Hidden
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-SenseAgent) { break }
        Start-Sleep -Milliseconds 200
    }

    if (-not (Test-SenseAgent)) {
        throw 'Sense companion did not become ready on 127.0.0.1:11471.'
    }
}

$officialStremio = Find-StremioExe -ExplicitPath $StremioExe
Write-Host "Starting official Stremio: $officialStremio"
Write-Host "Sense Web UI: $WebUiUrl"
Write-Host 'Sense downloads: handled by http://127.0.0.1:11471'

Start-Process -FilePath $officialStremio -ArgumentList @("--webui-url=$WebUiUrl")
