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
  foreach ($relative in @((Get-McpLocalRuntime).after_computer_setup)) {
    if ($relative) { & (Assert-McpChild $runtimeBase $relative) }
  }
}
Write-Host 'Updated managed runtime. Restart the tunnel after current tasks finish, refresh Local MCP tools, and start a new Chat conversation.'
