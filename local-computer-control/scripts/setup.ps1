param()
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Desktop control requires Windows.' }
$moduleRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
. (Join-Path (Split-Path -Parent $moduleRoot) 'shared\runtime-config.ps1')
$sharedStateRoot = Join-Path (Get-McpRuntimeRoot) '.runtime\local-computer-control'
$stateRoot = if ($env:LOCAL_COMPUTER_CONTROL_STATE_DIR) { $env:LOCAL_COMPUTER_CONTROL_STATE_DIR } else { $sharedStateRoot }
$env:LOCAL_COMPUTER_CONTROL_STATE_DIR = $stateRoot
New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
$bootstrapPython = Get-McpPython
$uvRoot = Join-Path $stateRoot 'install-tools'
$uv = Join-Path $uvRoot 'bin\uv.exe'
if (-not (Test-Path -LiteralPath $uv -PathType Leaf)) {
  & $bootstrapPython -m pip install --disable-pip-version-check --no-warn-script-location --target $uvRoot 'uv==0.12.24'
  if ($LASTEXITCODE -ne 0) { throw 'Could not install the isolated dependency installer.' }
}
$pythonRoot = Join-Path $stateRoot 'python'
$managedPython = Join-Path $pythonRoot 'cpython-3.14.8-windows-x86_64-none\python.exe'
if (-not (Test-Path -LiteralPath $managedPython -PathType Leaf)) {
  & $uv python install '3.14.8' --install-dir $pythonRoot
  # Some Windows installations cannot create the optional minor-version link.
  # Verify the actual interpreter rather than accepting an incomplete installation.
  if (-not (Test-Path -LiteralPath $managedPython -PathType Leaf)) { throw 'Python 3.14.8 installation failed.' }
}
& $managedPython --version
if ($LASTEXITCODE -ne 0) { throw 'Managed Python is unusable.' }
$venvRoot = Join-Path $stateRoot 'venv'
$python = Join-Path $venvRoot 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
  & $uv venv $venvRoot --python $managedPython
  if ($LASTEXITCODE -ne 0) { throw 'Desktop virtual environment creation failed.' }
}
$vendorRoot = Join-Path $moduleRoot 'vendor\windows-mcp'
$vendorFiles = @(Get-ChildItem -LiteralPath $vendorRoot -Recurse -File | Where-Object {
  $_.FullName.Substring($vendorRoot.Length + 1) -notmatch '(^|[\\/])(build|[^\\/]+\.egg-info|__pycache__)([\\/]|$)'
} | Sort-Object FullName | ForEach-Object { $_.FullName })
$inputs = @((Join-Path $moduleRoot 'requirements.lock')) + $vendorFiles
$hashText = ($inputs | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }) -join ':'
$marker = Join-Path $stateRoot 'dependencies.sha256'
$oldHash = if (Test-Path -LiteralPath $marker) { (Get-Content -LiteralPath $marker -Raw).Trim() } else { '' }
if ($oldHash -ne $hashText) {
  & $uv pip install --python $python -r (Join-Path $moduleRoot 'requirements.lock')
  if ($LASTEXITCODE -ne 0) { throw 'Desktop dependencies installation failed.' }
  & $uv pip install --python $python --no-deps --reinstall $vendorRoot
  if ($LASTEXITCODE -ne 0) { throw 'Windows-MCP installation failed.' }
  [IO.File]::WriteAllText($marker, $hashText, [Text.UTF8Encoding]::new($false))
}
$backendConfig = Join-Path $stateRoot 'windows-mcp.toml'
if (-not (Test-Path -LiteralPath $backendConfig -PathType Leaf)) { [IO.File]::WriteAllText($backendConfig, '# Isolated desktop backend: upstream defaults, broker-selected tools.', [Text.UTF8Encoding]::new($false)) }
$config = @{ python=$python; helper_python=$bootstrapPython; backend_config=$backendConfig; backend_version='0.8.7'; backend_commit='b455c2766c63599d466a6178641bac70787979a4' }
[IO.File]::WriteAllText((Join-Path $stateRoot 'runtime.json'), ($config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Host 'Shared Windows desktop runtime is installed. It starts on demand without another tunnel.'
