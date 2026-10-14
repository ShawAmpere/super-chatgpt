param()
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'shared\runtime-config.ps1')
$runtimeBase = Get-McpRuntimeRoot
$runtimeRoot = Join-Path $runtimeBase 'local-computer-control'
$serverPath = Join-Path $runtimeRoot 'server.js'
$node = if ($env:LOCAL_MCP_NODE_EXE) { $env:LOCAL_MCP_NODE_EXE } else { (Get-Command node.exe -ErrorAction Stop).Source }
$agy = if ($env:AGY_EXECUTABLE) { $env:AGY_EXECUTABLE } else { $command = Get-Command agy.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($command) { $command.Source } else { Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe' } }
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw 'Deploy local-computer-control before configuring the CLI.' }
if (-not (Test-Path -LiteralPath $agy -PathType Leaf)) { throw 'Antigravity CLI was not found.' }
$configPath = Join-Path $env:USERPROFILE '.gemini\config\mcp_config.json'
$existing = if (Test-Path -LiteralPath $configPath -PathType Leaf) { (Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).mcpServers.local_computer_control } else { $null }
if ($existing) {
  if ($existing.command -eq $node -and @($existing.args).Count -eq 1 -and $existing.args[0] -eq $serverPath) {
    Write-Host 'Antigravity shared desktop MCP entry is already configured.'
    return
  }
  throw 'An unrelated local_computer_control entry already exists. Preserve it and resolve the name before configuring.'
}
# Supported CLI operation; it preserves other global MCP definitions.
& $agy mcp add local_computer_control $node $serverPath
if ($LASTEXITCODE -ne 0) { throw 'Antigravity MCP configuration failed.' }
Write-Host 'Antigravity CLI now uses the same shared desktop service as Chat.'
