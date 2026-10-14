function Get-McpRuntimeRoot {
    if ($env:LOCAL_MCP_RUNTIME_ROOT) { return [IO.Path]::GetFullPath($env:LOCAL_MCP_RUNTIME_ROOT) }
    $local = Get-McpLocalRuntime
    if ($local.runtime_root) { return [IO.Path]::GetFullPath($local.runtime_root) }
    return Join-Path $env:LOCALAPPDATA 'SuperChatGPT'
}
function Get-McpPython {
    $local = Get-McpLocalRuntime
    $candidate = if ($env:LOCAL_FILE_READER_PYTHON) { $env:LOCAL_FILE_READER_PYTHON } elseif ($env:SUPER_CHATGPT_PYTHON) { $env:SUPER_CHATGPT_PYTHON } elseif ($local.python) { $local.python } else { 'python.exe' }
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).Path }
    $command = Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { throw 'Install Python 3.12+ or set SUPER_CHATGPT_PYTHON to its executable path.' }
    return $command.Source
}
function Get-McpLocalRuntime {
    $file = Join-Path $PSScriptRoot 'runtime.local.json'
    if (Test-Path -LiteralPath $file -PathType Leaf) { return Get-Content -LiteralPath $file -Raw | ConvertFrom-Json }
    return $null
}
function Get-McpWorkspacePolicy([string]$Base) {
    $file = Join-Path $Base 'shared\workspace-policy.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { $file = Join-Path $Base 'shared\workspace-policy.default.json' }
    $policy = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if ($policy.format -ne 1 -or @($policy.component_families.PSObject.Properties).Count -gt 16 -or
        @($policy.component_families.PSObject.Properties | Where-Object { $_.Name -notmatch '^[a-z][a-z0-9-]{0,63}$' }).Count) { throw 'Invalid workspace policy.' }
    return $policy
}
