param([switch]$SkipComputerSetup, [switch]$SkipDocumentSetup)
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$workspaceRoot = Split-Path -Parent $sourceRoot
. (Join-Path $workspaceRoot 'shared\deploy-runtime.ps1')
$runtimeBase = Get-McpRuntimeRoot
Publish-McpWorkspace $workspaceRoot $runtimeBase | Format-Table
if (-not $SkipDocumentSetup) { & (Join-Path $runtimeBase 'local-file-reader\scripts\setup-editor.ps1') }
if (-not $SkipComputerSetup) {
  & (Join-Path $runtimeBase 'local-computer-control\scripts\setup.ps1')
}
Write-Host 'Updated managed runtime. Restart the tunnel after current tasks finish, refresh Local MCP tools, and start a new Chat conversation.'
