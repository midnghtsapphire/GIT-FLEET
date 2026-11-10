# Registers a Windows scheduled task that runs `fleet.mjs tick` every few minutes:
# it checks the whiteboard, runs members whose schedule is due, and updates the
# fleet's draft PR. No GitHub Actions minutes are used.
# Usage:  powershell -ExecutionPolicy Bypass -File schedules\local\register-task.ps1 -Every 15
# 2026-11-10 Codex: local checks are opt-in and get their own task name so the
# owner's existing model/whiteboard task is never replaced by this registration.
# The original parameter declaration is preserved for history:
# REVVEL-DISABLED | AGENT: codex | MODEL: platform-selected | WR: revvel-standards#18339 | DATE: 2026-11-10 | STATUS: REPLACED
# param([int]$Every = 15)
# REVVEL-DISABLED-END
param([ValidateRange(1,1440)][int]$Every = 15, [switch]$LocalOnly, [string]$Jobs)
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$node = (Get-Command node).Source
if ($LocalOnly) {
  if (-not $Jobs -or -not [IO.Path]::IsPathRooted($Jobs) -or -not (Test-Path -LiteralPath $Jobs -PathType Leaf)) {
    throw 'LocalOnly requires -Jobs pointing to an existing absolute operator config'
  }
  $resolvedJobs = (Resolve-Path -LiteralPath $Jobs).Path
  if ($resolvedJobs.Contains('"')) { throw 'Jobs path must not contain a quote' }
  $taskName = 'GIT-FLEET local checks'
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    throw "Task '$taskName' already exists; inspect it rather than replacing it"
  }
  $localAction = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$node`" runner\fleet.mjs tick --local-only --jobs `"$resolvedJobs`"" -WorkingDirectory $root
  $localTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $Every)
  $localSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable
  Register-ScheduledTask -TaskName $taskName -Action $localAction -Trigger $localTrigger -Settings $localSettings `
    -Description 'Owned HULL daily/changed-packet checks. No model, GitHub, or Airtable calls. SQLite receipts at operator-configured path.' -ErrorAction Stop
  Write-Host "Registered '$taskName' every $Every minutes. Pause: Disable-ScheduledTask -TaskName '$taskName'"
  return
}
# conhost --headless keeps a console window from popping up on every tick (Windows 11).
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$node`" runner\fleet.mjs tick" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $Every)
Register-ScheduledTask -TaskName 'GIT-FLEET tick' -Action $action -Trigger $trigger `
  -Description 'Runs GIT-FLEET: answers the whiteboard, runs due members, updates the draft PR. Log: runs\tick.log' -Force
Write-Host "Registered 'GIT-FLEET tick' every $Every minutes (working dir: $root). Log: runs\tick.log"
Write-Host "Pause it any time:  Disable-ScheduledTask -TaskName 'GIT-FLEET tick'   (or untick Fleet On in Airtable)"
