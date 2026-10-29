[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$pythonWindowless = 'C:\Python312\pythonw.exe'
$watcherPath = Join-Path $root 'stremio_lifecycle.py'
if (-not (Test-Path -LiteralPath $pythonWindowless)) { throw 'The installed Python runtime was not found.' }
if (-not (Test-Path -LiteralPath $watcherPath)) { throw 'The lifecycle watcher was not found.' }
Remove-Item -LiteralPath (Join-Path $root 'lifecycle.disabled') -ErrorAction SilentlyContinue
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$backupPath = Join-Path $root 'lifecycle-startup-backup.json'
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
