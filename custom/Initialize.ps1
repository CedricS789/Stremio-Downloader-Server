[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$MediaRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$envFile = Join-Path $PSScriptRoot '.env'
if (Test-Path -LiteralPath $envFile) {
    throw '.env already exists. Existing secrets were preserved. Edit it yourself if you need to change the media path.'
}

$mediaFullPath = [System.IO.Path]::GetFullPath($MediaRoot)
if ($mediaFullPath -notmatch '^[A-Za-z]:\\') {
    throw 'Use an absolute path on a local Windows drive, for example D:\StremioMedia.'
}
if ($mediaFullPath.TrimEnd('\').Length -lt 4) {
    throw 'Choose a dedicated media folder, not the root of a drive.'
}
if ($mediaFullPath -match '[\r\n"$#]') {
    throw 'For this setup, use a folder path without newline, quote, dollar, or hash characters.'
}

function New-RandomHex {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

$folders = @(
    $mediaFullPath,
    (Join-Path $mediaFullPath 'media\movies'),
    (Join-Path $mediaFullPath 'media\tv')
)
foreach ($folder in $folders) {
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
}

$mediaDockerPath = $mediaFullPath.TrimEnd('\').Replace('\', '/')
$lines = @(
    "MEDIA_ROOT=$mediaDockerPath",
    "NUVI_ADMIN_PASSWORD=$(New-RandomHex)",
    "NUVI_SESSION_SECRET=$(New-RandomHex)",
    "NUVI_STREAM_SECRET=$(New-RandomHex)"
)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($envFile, $lines, $utf8NoBom)
Write-Host "Created media folders under $mediaFullPath"
Write-Host "Created $envFile with independent random secrets. Keep this file private."
Write-Host 'No software was started, no provider was contacted, and no downloads were queued.'
