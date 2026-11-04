# Registers a Windows scheduled task that runs `fleet.mjs tick` every few minutes:
# it checks the whiteboard, runs members whose schedule is due, and updates the
# fleet's draft PR. No GitHub Actions minutes are used.
# Usage:  powershell -ExecutionPolicy Bypass -File schedules\local\register-task.ps1 -Every 15
param([int]$Every = 15)
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$node = (Get-Command node).Source
# conhost --headless keeps a console window from popping up on every tick (Windows 11).
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$node`" runner\fleet.mjs tick" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $Every)
Register-ScheduledTask -TaskName 'GIT-FLEET tick' -Action $action -Trigger $trigger `
  -Description 'Runs GIT-FLEET: answers the whiteboard, runs due members, updates the draft PR. Log: runs\tick.log' -Force
Write-Host "Registered 'GIT-FLEET tick' every $Every minutes (working dir: $root). Log: runs\tick.log"
Write-Host "Pause it any time:  Disable-ScheduledTask -TaskName 'GIT-FLEET tick'   (or untick Fleet On in Airtable)"
