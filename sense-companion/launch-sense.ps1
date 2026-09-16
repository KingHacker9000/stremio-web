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

# Resolve script-relative paths after parameter binding for Windows PowerShell 5.1.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptDir) {
    $ScriptDir = (Get-Location).Path
}
if (-not $AgentExe) {
    $AgentExe = Join-Path $ScriptDir 'stremio-sense-agent.exe'
}

$SenseBaseUrl = 'http://127.0.0.1:11471'
$SenseStremioProxyUrl = "$SenseBaseUrl/stremio/"

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
        foreach ($exeName in @('stremio.exe', 'stremio-shell-ng.exe')) {
            $exe = Join-Path $expanded $exeName
            if (Test-Path -LiteralPath $exe -PathType Leaf) {
                return (Resolve-Path -LiteralPath $exe).Path
            }
        }
    }

    return $null
}

function Find-StremioExe {
    param([string]$ExplicitPath)

    if ($ExplicitPath) {
        $resolved = Resolve-StremioCandidate $ExplicitPath
        if ($resolved) { return $resolved }
        throw "Stremio executable not found at: $ExplicitPath"
    }

    foreach ($commandName in @('stremio.exe', 'stremio-shell-ng.exe')) {
        $command = Get-Command $commandName -ErrorAction SilentlyContinue
        if ($command -and $command.Source) {
            $resolved = Resolve-StremioCandidate $command.Source
            if ($resolved) { return $resolved }
        }
    }

    # Stremio's official Windows installer records its install location here.
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
            if ($resolved) { return $resolved }
        }
        catch {}
    }

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
            if ($resolved) { return $resolved }
        }
        catch {}
    }

    if ($env:LOCALAPPDATA) {
        $lnvRoot = Join-Path $env:LOCALAPPDATA 'Programs\LNV'
        if (Test-Path -LiteralPath $lnvRoot -PathType Container) {
            $versionedInstalls = Get-ChildItem -LiteralPath $lnvRoot -Directory -Filter 'Stremio-*' -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending
            foreach ($install in $versionedInstalls) {
                $resolved = Resolve-StremioCandidate $install.FullName
                if ($resolved) { return $resolved }
            }
        }
    }

    $candidates = @()
    if ($env:LOCALAPPDATA) {
        $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Stremio')
        $candidates += (Join-Path $env:LOCALAPPDATA 'Stremio')
    }
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Stremio') }
    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Stremio') }
    foreach ($candidate in $candidates) {
        $resolved = Resolve-StremioCandidate $candidate
        if ($resolved) { return $resolved }
    }

    # Resolve Start Menu shortcuts as another Windows-native source.
    $shortcutRoots = @()
    if ($env:APPDATA) { $shortcutRoots += (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') }
    if ($env:ProgramData) { $shortcutRoots += (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs') }
    try {
        $shell = New-Object -ComObject WScript.Shell
        foreach ($shortcutRoot in $shortcutRoots) {
            if (-not (Test-Path -LiteralPath $shortcutRoot -PathType Container)) { continue }
            $shortcuts = Get-ChildItem -LiteralPath $shortcutRoot -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like '*Stremio*' }
            foreach ($shortcut in $shortcuts) {
                try {
                    $target = $shell.CreateShortcut($shortcut.FullName).TargetPath
                    $resolved = Resolve-StremioCandidate $target
                    if ($resolved) { return $resolved }
                }
                catch {}
            }
        }
    }
    catch {}

    if ($env:LOCALAPPDATA) {
        $programsRoot = Join-Path $env:LOCALAPPDATA 'Programs'
        if (Test-Path -LiteralPath $programsRoot -PathType Container) {
            foreach ($exeName in @('stremio-shell-ng.exe', 'stremio.exe')) {
                $found = Get-ChildItem -LiteralPath $programsRoot -Filter $exeName -File -Recurse -ErrorAction SilentlyContinue |
                    Select-Object -First 1
                if ($found) { return $found.FullName }
            }
        }
    }

    throw 'Could not automatically locate the installed official Stremio executable. Pass -StremioExe with its full path.'
}

function Get-SenseAgentHealth {
    try {
        return Invoke-RestMethod -Uri "$SenseBaseUrl/v1/health" -TimeoutSec 1
    }
    catch {
        return $null
    }
}

function Test-CompatibleSenseAgent {
    param($Health)
    return [bool]($Health -and $Health.ok -and $Health.stremioProxy -eq '/stremio/')
}

function Stop-StaleSenseAgent {
    # Only do this when something answering as Sense is known to be stale.
    Get-Process -Name 'stremio-sense-agent' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Get-SenseAgentHealth)) { return }
        Start-Sleep -Milliseconds 150
    }
}

function Start-SenseAgent {
    if ($DownloadDir) {
        Start-Process -FilePath $AgentExe -ArgumentList @('--download-dir', $DownloadDir) -WindowStyle Hidden
    }
    else {
        Start-Process -FilePath $AgentExe -WindowStyle Hidden
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        $health = Get-SenseAgentHealth
        if (Test-CompatibleSenseAgent $health) { return $health }
        Start-Sleep -Milliseconds 200
    }
    throw 'Sense companion did not become ready with the Stremio proxy on 127.0.0.1:11471.'
}

function Build-SenseWebUiUrl {
    param([string]$BaseUrl)

    if ($BaseUrl -match 'streamingServerUrl=') {
        return $BaseUrl
    }

    $encodedProxy = [Uri]::EscapeDataString($SenseStremioProxyUrl)
    if ($BaseUrl.Contains('#')) {
        if ($BaseUrl.Contains('?')) {
            return "$BaseUrl&streamingServerUrl=$encodedProxy"
        }
        return "$BaseUrl?streamingServerUrl=$encodedProxy"
    }
    return $BaseUrl.TrimEnd('/') + '/#/?streamingServerUrl=' + $encodedProxy
}

function Stop-RunningOfficialStremio {
    param([string]$OfficialExe)

    $officialPath = (Resolve-Path -LiteralPath $OfficialExe).Path
    $matches = @()
    foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
        try {
            if ($process.Path -and [string]::Equals((Resolve-Path -LiteralPath $process.Path).Path, $officialPath, [StringComparison]::OrdinalIgnoreCase)) {
                $matches += $process
            }
        }
        catch {}
    }

    if ($matches.Count -eq 0) { return }
    Write-Host 'Restarting the already-running official Stremio instance so Sense launch arguments take effect.'
    foreach ($process in $matches) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ([DateTime]::UtcNow -lt $deadline) {
        $stillRunning = $false
        foreach ($process in $matches) {
            if (Get-Process -Id $process.Id -ErrorAction SilentlyContinue) {
                $stillRunning = $true
                break
            }
        }
        if (-not $stillRunning) { return }
        Start-Sleep -Milliseconds 150
    }
}

if (-not (Test-Path -LiteralPath $AgentExe -PathType Leaf)) {
    throw "Sense companion not found at: $AgentExe"
}

$health = Get-SenseAgentHealth
if ($health -and -not (Test-CompatibleSenseAgent $health)) {
    Write-Host 'Replacing an older running Sense companion with this bundle version.'
    Stop-StaleSenseAgent
    $health = $null
}
if (-not (Test-CompatibleSenseAgent $health)) {
    $health = Start-SenseAgent
}

$officialStremio = Find-StremioExe -ExplicitPath $StremioExe
$effectiveWebUiUrl = Build-SenseWebUiUrl -BaseUrl $WebUiUrl
Stop-RunningOfficialStremio -OfficialExe $officialStremio

Write-Host "Starting official Stremio: $officialStremio"
Write-Host "Sense Web UI: $effectiveWebUiUrl"
Write-Host "Sense Stremio proxy: $SenseStremioProxyUrl -> http://127.0.0.1:11470/"
Write-Host "Sense downloads: handled by $SenseBaseUrl"

Start-Process -FilePath $officialStremio -ArgumentList @("--webui-url=$effectiveWebUiUrl")
