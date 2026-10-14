param([switch]$Storage)
$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$node=(Get-Command node.exe -ErrorAction Stop).Source
$arguments=@((Join-Path $workspace 'shared\runtime-diagnostics.js'),$workspace)
if($Storage){$arguments+='--storage'}
& $node @arguments
if($LASTEXITCODE -ne 0){throw 'Local read-only runtime diagnosis failed.'}
