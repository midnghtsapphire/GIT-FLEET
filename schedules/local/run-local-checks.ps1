param(
  [Parameter(Mandatory)][string]$Node,
  [Parameter(Mandatory)][string]$Jobs
)

$ErrorActionPreference = 'Stop'
if ($Jobs.Contains('"') -or -not [IO.Path]::IsPathRooted($Jobs)) {
  throw 'Jobs must be an absolute path without quotes'
}
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$arguments = "runner\fleet.mjs tick --local-only --jobs `"$Jobs`""
$child = Start-Process -FilePath $Node -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -Wait -PassThru
exit $child.ExitCode
