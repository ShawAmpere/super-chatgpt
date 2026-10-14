. (Join-Path $PSScriptRoot 'runtime-config.ps1')
function Resolve-McpWindowsProxy([bool]$Enabled, [string]$Server) {
  if (-not $Enabled -or [string]::IsNullOrWhiteSpace($Server)) { return $null }
  $parts = @($Server.Split(';') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  $selected = $null
  foreach ($scheme in @('https', 'http')) {
    foreach ($part in $parts) {
      if ($part -match ('(?i)^' + $scheme + '=(.+)$')) { $selected = $Matches[1]; break }
    }
    if ($selected) { break }
  }
  if (-not $selected -and $parts.Count -eq 1 -and -not $parts[0].Contains('=')) { $selected = $parts[0] }
  if (-not $selected) { return $null }
  if ($selected -notmatch '^[a-z][a-z0-9+.-]*://') { $selected = 'http://' + $selected }
  $uri = $null
  if (-not [Uri]::TryCreate($selected, [UriKind]::Absolute, [ref]$uri) -or
      $uri.Scheme -notin @('http', 'https', 'socks5', 'socks5h') -or -not $uri.Host -or
      $uri.AbsolutePath -ne '/' -or $uri.Query -or $uri.Fragment) {
    throw 'Windows proxy is invalid. Set CONTROL_PLANE_HTTP_PROXY explicitly.'
  }
  return $uri.AbsoluteUri.TrimEnd('/')
}

function Get-McpTunnelProxyReference {
  foreach ($name in @('CONTROL_PLANE_HTTP_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY')) {
    if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
      Write-Host ('Tunnel proxy: explicit {0}' -f $name)
      return ('env:' + $name)
    }
  }
  $settings = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
  $proxy = Resolve-McpWindowsProxy ($settings.ProxyEnable -eq 1) ([string]$settings.ProxyServer)
  if ($proxy) {
    $env:CONTROL_PLANE_HTTP_PROXY = $proxy
    Write-Host 'Tunnel proxy: current Windows system proxy (process only).'
    return 'env:CONTROL_PLANE_HTTP_PROXY'
  }
  if ($settings.AutoConfigURL) { Write-Warning 'Automatic proxy scripts are not imported. Set CONTROL_PLANE_HTTP_PROXY if direct access fails.' }
  Write-Host 'Tunnel proxy: direct connection.'
  return $null
}

function Test-McpTunnelAccess([string]$TunnelClientPath, [string]$TunnelId, [string]$ProxyReference) {
  $previousHttps = $env:HTTPS_PROXY
  try {
    # The admin subcommand uses HTTPS_PROXY, whereas run/doctor accept a scoped proxy.
    if ($ProxyReference) {
      $proxy = if ($ProxyReference.StartsWith('env:')) { [Environment]::GetEnvironmentVariable($ProxyReference.Substring(4)) } else { $ProxyReference }
      if ($proxy -and $proxy.StartsWith('env:')) { $proxy = [Environment]::GetEnvironmentVariable($proxy.Substring(4)) }
      if ([string]::IsNullOrWhiteSpace($proxy)) { throw 'The selected proxy environment variable is empty.' }
      $env:HTTPS_PROXY = $proxy
    }
    $raw = & $TunnelClientPath admin --json tunnels get $TunnelId
    $code = $LASTEXITCODE
    try { $metadata = ($raw -join "`n") | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'Tunnel access check returned no valid JSON. Check the tunnel client and network.' }
    if ($code -ne 0 -or $metadata.error -or $metadata.id -ne $TunnelId) {
      $message = [string]$metadata.error.message
      if ($env:CONTROL_PLANE_API_KEY) { $message = $message.Replace($env:CONTROL_PLANE_API_KEY, '<redacted>') }
      $message = $message -replace '(?i)sk-[A-Za-z0-9_-]{8,}', '<redacted>' -replace '(://)[^/@\s]+:[^/@\s]+@', '$1<redacted>@'
      throw ('Tunnel network/authentication check failed: {0}. Check the proxy, runtime key and tunnel permissions.' -f $message)
    }
    Write-Host 'Tunnel network and runtime-key access: verified.'
  } finally { $env:HTTPS_PROXY = $previousHttps }
}

function Show-McpTunnelHealth([string]$TunnelId, [int]$TunnelProcessId) {
  $ports = @(Get-NetTCPConnection -OwningProcess $TunnelProcessId -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' } | Select-Object -ExpandProperty LocalPort -Unique)
  foreach ($port in $ports) {
    $base = 'http://127.0.0.1:' + $port
    try {
      $status = Invoke-RestMethod -Uri ($base + '/api/status') -TimeoutSec 3
      if ($status.control_plane_tunnel_id -ne $TunnelId) { continue }
      $health = Invoke-RestMethod -Uri ($base + '/health?details=true') -TimeoutSec 3
    } catch { continue }
    $control = $health.components.'control-plane'
    Write-Host ('Tunnel diagnostic UI: {0}/ui' -f $base)
    Write-Host ('Control-plane: {0}; reason: {1}; consecutive failures: {2}' -f $control.status, $control.reason_code, $control.details.consecutive_failures)
    Write-Host ('Local MCP: {0}; observed tools: {1}' -f $health.components.mcp.status, $health.components.mcp.details.tools_list.retained_count)
    if ($control.status -eq 'degraded' -or $control.details.consecutive_failures -gt 0) {
      throw 'Tunnel is running but control-plane polling is failing. Restart after checking the proxy/network; local ready=true does not prove connectivity.'
    }
    if ($control.status -ne 'ok') { Write-Warning 'Control-plane success is not yet observed. Do not treat process startup as a successful ChatGPT connection.' }
    return
  }
  throw 'The existing tunnel process has no reachable diagnostic endpoint. Check its window instead of starting a duplicate.'
}

function Stop-McpOwnedProcess($Expected, [string]$OwnerSid) {
  $target = Get-Process -Id $Expected.ProcessId -ErrorAction SilentlyContinue
  if (-not $target) { return }
  try {
    # Retain the original process handle so a recycled PID cannot target a new process.
    try { $null = $target.Handle } catch { if ($target.HasExited) { return }; throw }
    $current = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $Expected.ProcessId) -ErrorAction Stop
    if (-not $current -or $target.HasExited) { return }
    if ($current.CreationDate -ne $Expected.CreationDate -or $current.Name -ne $Expected.Name -or
        $current.Name -notin @('tunnel-client.exe', 'powershell.exe', 'cmd.exe') -or $current.ProcessId -eq $PID) {
      throw 'Restart refused: the captured process identity changed.'
    }
    try { $owner = Invoke-CimMethod -InputObject $current -MethodName GetOwnerSid -ErrorAction Stop }
    catch { if ($target.HasExited) { return }; throw }
    if ($target.HasExited) { return }
    if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $OwnerSid) { throw 'Restart refused: the process belongs to another Windows user or its owner cannot be verified.' }
    Write-Host ('Stopping old {0} (PID {1}).' -f $current.Name, $current.ProcessId)
    try { $target.Kill() } catch { if (-not $target.HasExited) { throw } }
    if (-not $target.WaitForExit(10000)) { throw 'The old tunnel process did not exit; no new instance will be started.' }
  } finally { $target.Dispose() }
}

function Stop-McpTunnelInstances([object[]]$Instances, [string]$TunnelId, [string]$OwnerSid, [string]$LauncherFile) {
  $pattern = '(?<![A-Za-z0-9_])' + [regex]::Escape($TunnelId) + '(?![A-Za-z0-9_])'
  foreach ($instance in $Instances) {
    if ($instance.Name -ne 'tunnel-client.exe' -or [string]$instance.CommandLine -notmatch $pattern) {
      throw 'Restart refused: the captured process is not this tunnel.'
    }
    $launcher = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $instance.ParentProcessId) -ErrorAction Stop
    $wrapper = $null
    if ($launcher -and $launcher.Name -eq 'powershell.exe' -and
        [string]$launcher.CommandLine -match 'LOCAL_MCP_LAUNCHER_FILE' -and $launcher.CreationDate -le $instance.CreationDate) {
      $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $launcher.ParentProcessId) -ErrorAction Stop
      $wrapperPattern = '(?i)\s/c\s+"{0,2}' + [regex]::Escape($LauncherFile) + '[\s"]*$'
      if ($candidate -and $candidate.Name -eq 'cmd.exe' -and
          [string]$candidate.CommandLine -match $wrapperPattern -and $candidate.CreationDate -le $launcher.CreationDate) { $wrapper = $candidate }
    } else { $launcher = $null }
    Stop-McpOwnedProcess $instance $OwnerSid
    if ($launcher) { Stop-McpOwnedProcess $launcher $OwnerSid }
    if ($wrapper) { Stop-McpOwnedProcess $wrapper $OwnerSid }
  }
}

function Start-McpTunnel {
param([string]$ModuleRoot, [string]$TunnelId, [string]$TunnelClientPath, [string]$NodePath, [switch]$DoctorOnly)
$ErrorActionPreference = 'Stop'
if (-not $TunnelId) {
  $configPath = Join-Path $ModuleRoot 'tunnel.json'
  if (Test-Path -LiteralPath $configPath) { $TunnelId = (Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).tunnel_id }
}
if (-not $NodePath) { $NodePath = (Get-Command node.exe -ErrorAction Stop).Source }
$python = $null
try { $python = Get-McpPython } catch { Write-Warning $_.Exception.Message }
if (-not $env:LOCAL_FILE_READER_PYTHON -and $python) { $env:LOCAL_FILE_READER_PYTHON = $python }
if (-not $env:LOCAL_FILE_READER_LIBREOFFICE) { $env:LOCAL_FILE_READER_LIBREOFFICE = Join-Path $env:ProgramFiles 'LibreOffice\program\soffice.exe' }

if ($TunnelId -notmatch '^tunnel_[A-Za-z0-9]+$') {
  throw 'Set CONTROL_PLANE_TUNNEL_ID or pass -TunnelId with a valid tunnel ID.'
}
if (-not $TunnelClientPath) {
  $bundled = Join-Path $ModuleRoot 'bin\tunnel-client.exe'
  if (Test-Path -LiteralPath $bundled -PathType Leaf) {
    $TunnelClientPath = $bundled
  } else {
    $installed = Get-Command tunnel-client.exe -ErrorAction SilentlyContinue
    if ($installed) { $TunnelClientPath = $installed.Source }
  }
}
if (-not $TunnelClientPath -or -not (Test-Path -LiteralPath $TunnelClientPath -PathType Leaf)) {
  throw 'tunnel-client.exe was not found. Pass -TunnelClientPath or set TUNNEL_CLIENT_EXE.'
}

$serverPath = Join-Path $ModuleRoot 'server.js'
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Node.js executable not found: $NodePath" }
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw "MCP server not found: $serverPath" }
if ((Split-Path -Leaf $ModuleRoot) -eq 'local-mcp-gateway') {
  $workspaceStatus = & $NodePath (Join-Path (Split-Path -Parent $ModuleRoot) 'shared\workspace-release.js') (Split-Path -Parent $ModuleRoot)
  if ($LASTEXITCODE -ne 0) { throw "Workspace compatibility check failed: $workspaceStatus. Rerun gateway scripts/update-runtime.ps1." }
  $workspaceState = $workspaceStatus | ConvertFrom-Json
  foreach ($issue in $workspaceState.issues) { Write-Warning $issue }
foreach ($serviceName in @('local-file-reader','local-computer-control')) {
  $serviceRoot = Join-Path (Split-Path -Parent $ModuleRoot) $serviceName
  if (-not (Test-Path -LiteralPath (Join-Path $serviceRoot 'server.js') -PathType Leaf)) { throw "Missing local service: $serviceRoot" }
}
}
$computerState = if ($env:LOCAL_COMPUTER_CONTROL_STATE_DIR) { $env:LOCAL_COMPUTER_CONTROL_STATE_DIR } else { Join-Path (Get-McpRuntimeRoot) '.runtime\local-computer-control' }
$env:LOCAL_COMPUTER_CONTROL_STATE_DIR = $computerState
$computerConfig = Join-Path $computerState 'runtime.json'
if (-not (Test-Path -LiteralPath $computerConfig -PathType Leaf)) {
  Write-Warning "Desktop runtime configuration not found: $computerConfig. Run local-computer-control/scripts/setup.ps1 to enable desktop tools. File and command tools can still start."
}
foreach ($runtimePath in @($env:LOCAL_FILE_READER_PYTHON, $env:LOCAL_FILE_READER_LIBREOFFICE)) {
  if (-not $runtimePath -or -not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) { Write-Warning "Optional service runtime was not found: $runtimePath. Text/files and other installed services remain available; converter-dependent operations report their own error." }
}
if (-not (Test-Path -LiteralPath (Join-Path $ModuleRoot 'node_modules\@modelcontextprotocol\sdk\package.json')) -and -not (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $ModuleRoot) 'node_modules\@modelcontextprotocol\sdk\package.json'))) {
  throw 'MCP dependencies are missing. Run this source module scripts/update-runtime.ps1 first.'
}
if ($NodePath.Contains('"') -or $serverPath.Contains('"') -or $NodePath.Contains(',') -or $serverPath.Contains(',')) {
  throw 'Node.js and MCP server paths must not contain quotes or commas for the tunnel-client command format.'
}

$mcpCommand = 'command="{0}" "{1}",channel=main' -f ($NodePath -replace '\\','/'), ($serverPath -replace '\\','/')
if ($PSVersionTable.PSVersion.Major -lt 7) {
  # Windows PowerShell's legacy native-command binder drops embedded quotes unless escaped.
  $mcpCommand = $mcpCommand.Replace('"', '\"')
}
$commonArgs = @(
  '--control-plane.tunnel-id', $TunnelId,
  '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY',
  '--mcp.command', $mcpCommand,
  '--health.listen-addr', '127.0.0.1:0'
)

$enteredKey = $false
if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) {
  $secureKey = Read-Host 'Enter the tunnel runtime API key (input hidden)' -AsSecureString
  $secretHandle = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  try { $env:CONTROL_PLANE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretHandle) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretHandle) }
  $enteredKey = $true
}
if ([string]::IsNullOrWhiteSpace($env:CONTROL_PLANE_API_KEY)) { throw 'The tunnel runtime API key is empty.' }

$previousControlProxy = $env:CONTROL_PLANE_HTTP_PROXY
try {
  $proxyReference = Get-McpTunnelProxyReference
  if ($proxyReference) { $commonArgs += @('--control-plane.http-proxy', $proxyReference) }
  Test-McpTunnelAccess $TunnelClientPath $TunnelId $proxyReference
  & $TunnelClientPath doctor @commonArgs --explain
  if ($LASTEXITCODE -ne 0) { throw "tunnel-client doctor failed with exit code $LASTEXITCODE." }
  if (-not $DoctorOnly) {
    Write-Host 'Starting the ChatGPT MCP tunnel. Keep this terminal open while using the ChatGPT connection.'
    & $TunnelClientPath run @commonArgs
    if ($LASTEXITCODE -ne 0) { throw "tunnel-client exited with code $LASTEXITCODE." }
  }
}
finally {
  $env:CONTROL_PLANE_HTTP_PROXY = $previousControlProxy
  if ($enteredKey) { Remove-Item Env:CONTROL_PLANE_API_KEY -ErrorAction SilentlyContinue }
}

}
