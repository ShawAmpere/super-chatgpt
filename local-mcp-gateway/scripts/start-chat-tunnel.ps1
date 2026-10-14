param(
  [string]$TunnelId = $env:CONTROL_PLANE_TUNNEL_ID,
  [string]$TunnelClientPath = $env:TUNNEL_CLIENT_EXE,
  [string]$NodePath = $env:LOCAL_MCP_NODE_EXE,
  [switch]$DoctorOnly
)
$ErrorActionPreference = 'Stop'
$moduleRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path (Split-Path -Parent $moduleRoot) 'shared\tunnel-launch.ps1')
Start-McpTunnel -ModuleRoot $moduleRoot -TunnelId $TunnelId -TunnelClientPath $TunnelClientPath -NodePath $NodePath -DoctorOnly:$DoctorOnly
