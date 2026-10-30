[CmdletBinding()]
param(
    [string]$PythonPath = ''
)
$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$root = Split-Path $scriptDir -Parent

$pythonWindowless = $PythonPath
if (-not $pythonWindowless) {
    # Check PATH for pythonw.exe
    $pywCmd = Get-Command pythonw.exe -ErrorAction SilentlyContinue
    if ($pywCmd) {
        $pythonWindowless = $pywCmd.Source
    } else {
        # Check if python.exe is in PATH and pythonw is in the same folder
        $pyCmd = Get-Command python.exe -ErrorAction SilentlyContinue
        if ($pyCmd) {
            $candidate = Join-Path (Split-Path $pyCmd.Source) 'pythonw.exe'
            if (Test-Path -LiteralPath $candidate) { $pythonWindowless = $candidate }
        }
    }
    # Check common Python installation paths
    if (-not $pythonWindowless) {
        $candidates = @(
            'C:\Python312\pythonw.exe',
            'C:\Python311\pythonw.exe',
            'C:\Python313\pythonw.exe',
            "$env:LOCALAPPDATA\Programs\Python\Python312\pythonw.exe",
            "$env:LOCALAPPDATA\Programs\Python\Python311\pythonw.exe",
            "$env:LOCALAPPDATA\Programs\Python\Python313\pythonw.exe"
        )
        foreach ($c in $candidates) {
            if (Test-Path -LiteralPath $c) {
                $pythonWindowless = $c
                break
            }
        }
    }
}

if (-not $pythonWindowless -or -not (Test-Path -LiteralPath $pythonWindowless)) {
    throw "Python runtime (pythonw.exe) was not found. Install Python or pass its path: .\Install-Lifecycle.ps1 -PythonPath 'C:\Path\To\pythonw.exe'"
}

$settingsFile = Join-Path $scriptDir 'lifecycle-settings.json'
$exampleSettings = Join-Path $scriptDir 'lifecycle-settings.example.json'
if (-not (Test-Path -LiteralPath $settingsFile) -and (Test-Path -LiteralPath $exampleSettings)) {
    Copy-Item -LiteralPath $exampleSettings -Destination $settingsFile
}
$watcherPath = Join-Path $scriptDir 'stremio_lifecycle.py'
if (-not (Test-Path -LiteralPath $watcherPath)) { throw 'The lifecycle watcher was not found.' }
Remove-Item -LiteralPath (Join-Path $scriptDir 'lifecycle.disabled') -ErrorAction SilentlyContinue
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$backupPath = Join-Path $scriptDir 'lifecycle-startup-backup.json'
if (-not (Test-Path -LiteralPath $backupPath)) {
    $dockerStartup = (Get-ItemProperty -LiteralPath $runKey -ErrorAction SilentlyContinue).'Docker Desktop'
    @{ dockerStartupCommand = $dockerStartup } | ConvertTo-Json | Set-Content -LiteralPath $backupPath -Encoding utf8
}
$arguments = '-B "' + $watcherPath + '"'
$taskName = 'StremioAutomationWatcher'
try {
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute $pythonWindowless -Argument $arguments -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Description 'Start the local media services with Stremio; stop only after downloads and imports finish.' -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    $mechanism = 'Scheduled task at Windows sign-in'
}
catch {
    # Standard-user fallback when Windows disallows task registration.
    $startupCommand = '"' + $pythonWindowless + '" ' + $arguments
    New-ItemProperty -LiteralPath $runKey -Name 'StremioAutomationGuardian' -PropertyType String -Value $startupCommand -Force | Out-Null
    Start-Process -FilePath $pythonWindowless -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden
    $mechanism = 'Current-user Windows sign-in startup entry'
}
Write-Output $mechanism
# Docker should be started by the watcher, rather than unconditionally at sign-in.
# Its original startup command is saved above for an easy rollback.
Remove-ItemProperty -LiteralPath $runKey -Name 'Docker Desktop' -ErrorAction SilentlyContinue
Write-Output 'Docker unconditional sign-in startup disabled; original value backed up.'
