param([switch]$SkipComputerSetup, [switch]$SkipDocumentSetup)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if ($env:OS -ne 'Windows_NT') { throw 'This distribution targets Windows.' }
. (Join-Path $root 'shared\runtime-config.ps1')
$env:LOCAL_FILE_READER_PYTHON = Get-McpPython
& $env:LOCAL_FILE_READER_PYTHON -c 'import sys; assert sys.version_info >= (3,12), "Python 3.12+ is required"'
if ($LASTEXITCODE -ne 0) { throw 'Python version check failed.' }
Push-Location $root
try {
    & npm.cmd run install:dependencies
    if ($LASTEXITCODE -ne 0) { throw 'Source dependency installation failed.' }
    & (Join-Path $root 'local-mcp-gateway\scripts\update-runtime.ps1') -SkipComputerSetup:$SkipComputerSetup -SkipDocumentSetup:$SkipDocumentSetup
} finally { Pop-Location }
