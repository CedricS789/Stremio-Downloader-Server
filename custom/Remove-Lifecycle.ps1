[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
# Disabling the observer deliberately does not interrupt any media downloads.
Set-Content -LiteralPath (Join-Path $root 'lifecycle.disabled') -Value 'Disabled by user'
$task = Get-ScheduledTask -TaskName 'StremioAutomationWatcher' -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName 'StremioAutomationWatcher' -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'StremioAutomationWatcher' -Confirm:$false
}
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Remove-ItemProperty -LiteralPath $runKey -Name 'StremioAutomationGuardian' -ErrorAction SilentlyContinue
$backupPath = Join-Path $root 'lifecycle-startup-backup.json'
if (Test-Path -LiteralPath $backupPath) {
    $backup = Get-Content -LiteralPath $backupPath -Raw | ConvertFrom-Json
    if ($backup.dockerStartupCommand) {
        New-ItemProperty -LiteralPath $runKey -Name 'Docker Desktop' -PropertyType String `
            -Value $backup.dockerStartupCommand -Force | Out-Null
    }
}
Write-Output 'Automatic lifecycle control removed. Existing downloads and services were left running.'
