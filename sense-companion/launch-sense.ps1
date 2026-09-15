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

function Resolve-StremioCandidate {
    param([string]$Candidate)

    if ([string]::IsNullOrWhiteSpace($Candidate)) {
        return $null
    }

    $expanded = [Environment]::ExpandEnvironmentVariables($Candidate.Trim().Trim('"'))

    if (Test-Path -LiteralPath $expanded -PathType Leaf) {
        return (Resolve-Path -LiteralPath $expanded).Path
    }

    if (Test-Path -LiteralPath $expanded -PathType Container) {
        $exe = Join-Path $expanded 'stremio.exe'
        if (Test-Path -LiteralPath $exe -PathType Leaf) {
            return (Resolve-Path -LiteralPath $exe).Path
        }
    }

    return $null
}

function Find-StremioExe {
    param([string]$ExplicitPath)

    if ($ExplicitPath) {
        $resolved = Resolve-StremioCandidate $ExplicitPath
        if ($resolved) {
            return $resolved
        }
        throw "Stremio executable not found at: $ExplicitPath"
    }

    $command = Get-Command stremio.exe -ErrorAction SilentlyContinue
    if ($command -and $command.Source) {
        $resolved = Resolve-StremioCandidate $command.Source
        if ($resolved) {
            return $resolved
        }
    }

    # Stremio's Windows installer records its install location here. Support
    # both user- and machine-wide installs, including 32-bit registry views.
    $stremioRegistryKeys = @(
        'HKCU:\Software\SmartCode\Stremio',
        'HKLM:\Software\SmartCode\Stremio',
        'HKCU:\Software\WOW6432Node\SmartCode\Stremio',
        'HKLM:\Software\WOW6432Node\SmartCode\Stremio'
    )

    foreach ($registryPath in $stremioRegistryKeys) {
        try {
            $installLocation = (Get-ItemProperty -LiteralPath $registryPath -Name InstallLocation -ErrorAction Stop).InstallLocation
            $resolved = Resolve-StremioCandidate $installLocation
            if ($resolved) {
                return $resolved
            }
        }
        catch {
            # Missing or inaccessible registry key; continue discovery.
        }
    }

    # Some Windows installers register the executable through App Paths.
    $appPathKeys = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\stremio.exe',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\stremio.exe',
        'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\stremio.exe',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\stremio.exe'
    )

    foreach ($appPathKey in $appPathKeys) {
        try {
            $registeredExe = (Get-Item -LiteralPath $appPathKey -ErrorAction Stop).GetValue('')
            $resolved = Resolve-StremioCandidate $registeredExe
            if ($resolved) {
                return $resolved
            }
        }
        catch {
            # No App Paths registration; continue discovery.
        }
    }

    # Official desktop builds use versioned Stremio-* folders under LNV.
    if ($env:LOCALAPPDATA) {
        $lnvRoot = Join-Path $env:LOCALAPPDATA 'Programs\LNV'
        if (Test-Path -LiteralPath $lnvRoot -PathType Container) {
            $versionedInstalls = Get-ChildItem -LiteralPath $lnvRoot -Directory -Filter 'Stremio-*' -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending
            foreach ($install in $versionedInstalls) {
                $resolved = Resolve-StremioCandidate $install.FullName
                if ($resolved) {
                    return $resolved
                }
            }
        }
    }

    $candidates = @()
    if ($env:LOCALAPPDATA) {
        $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Stremio\stremio.exe')
        $candidates += (Join-Path $env:LOCALAPPDATA 'Stremio\stremio.exe')
    }
    if ($env:ProgramFiles) {
        $candidates += (Join-Path $env:ProgramFiles 'Stremio\stremio.exe')
    }
    if (${env:ProgramFiles(x86)}) {
        $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Stremio\stremio.exe')
    }

    foreach ($candidate in $candidates) {
        $resolved = Resolve-StremioCandidate $candidate
        if ($resolved) {
            return $resolved
        }
    }

    # Resolve Stremio Start Menu shortcuts as another reliable Windows source.
    $shortcutRoots = @()
    if ($env:APPDATA) {
        $shortcutRoots += (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
    }
    if ($env:ProgramData) {
        $shortcutRoots += (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
    }

    try {
        $shell = New-Object -ComObject WScript.Shell
        foreach ($shortcutRoot in $shortcutRoots) {
            if (-not (Test-Path -LiteralPath $shortcutRoot -PathType Container)) {
                continue
            }
            $shortcuts = Get-ChildItem -LiteralPath $shortcutRoot -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like '*Stremio*' }
            foreach ($shortcut in $shortcuts) {
                try {
                    $target = $shell.CreateShortcut($shortcut.FullName).TargetPath
                    $resolved = Resolve-StremioCandidate $target
                    if ($resolved) {
                        return $resolved
                    }
                }
                catch {
                    # Broken shortcut; keep looking.
                }
            }
        }
    }
    catch {
        # WScript.Shell may be disabled by policy; continue discovery.
    }

    # Final bounded fallback: search only the normal per-user Programs tree.
    if ($env:LOCALAPPDATA) {
        $programsRoot = Join-Path $env:LOCALAPPDATA 'Programs'
        if (Test-Path -LiteralPath $programsRoot -PathType Container) {
            $found = Get-ChildItem -LiteralPath $programsRoot -Filter 'stremio.exe' -File -Recurse -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($found) {
                return $found.FullName
            }
        }
    }

    throw 'Could not automatically locate the installed official Stremio executable. Pass -StremioExe with its full path.'
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
