param([string]$PythonPath = $env:LOCAL_FILE_READER_PYTHON, [string]$EnvironmentPath)
$ErrorActionPreference = 'Stop'
$moduleRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path (Split-Path -Parent $moduleRoot) 'shared\runtime-config.ps1')
if (-not $EnvironmentPath) { $EnvironmentPath = Join-Path (Get-McpRuntimeRoot) '.runtime\document-editor' }
if (-not $PythonPath) {
  $PythonPath = Get-McpPython
}
if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) { throw 'Set LOCAL_FILE_READER_PYTHON to an installed Python 3.12+ executable.' }
$EnvironmentPath = [IO.Path]::GetFullPath($EnvironmentPath)
$editorPython = Join-Path $EnvironmentPath 'Scripts\python.exe'
$requirements = Join-Path $moduleRoot 'editor-requirements.txt'
$requirementsHash = (Get-FileHash -LiteralPath $requirements).Hash
$marker = Join-Path $EnvironmentPath '.requirements-sha256'
if (-not (Test-Path -LiteralPath $editorPython -PathType Leaf)) {
  & $PythonPath -m venv $EnvironmentPath
  if ($LASTEXITCODE -ne 0) { throw 'Document editor environment creation failed.' }
}
$installed = if (Test-Path -LiteralPath $marker) { (Get-Content -LiteralPath $marker -Raw).Trim() } else { '' }
if ($installed -ne $requirementsHash) {
  & $editorPython -m pip install --disable-pip-version-check --requirement $requirements
  if ($LASTEXITCODE -ne 0) { throw 'Document editor dependencies could not be installed; other file tools remain usable.' }
}
& $editorPython (Join-Path $moduleRoot 'document-editor.py') capabilities
if ($LASTEXITCODE -ne 0) { throw 'Document editor dependency check failed.' }
[IO.File]::WriteAllText($marker, $requirementsHash, [Text.UTF8Encoding]::new($false))
Write-Output "Document editor ready: $editorPython"
