function Get-McpRuntimeRoot {
    if ($env:LOCAL_MCP_RUNTIME_ROOT) { return [IO.Path]::GetFullPath($env:LOCAL_MCP_RUNTIME_ROOT) }
    return Join-Path $env:LOCALAPPDATA 'SuperChatGPT'
}
function Get-McpPython {
    $candidate = if ($env:LOCAL_FILE_READER_PYTHON) { $env:LOCAL_FILE_READER_PYTHON } elseif ($env:SUPER_CHATGPT_PYTHON) { $env:SUPER_CHATGPT_PYTHON } else { 'python.exe' }
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).Path }
    $command = Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { throw 'Install Python 3.12+ or set SUPER_CHATGPT_PYTHON to its executable path.' }
    return $command.Source
}
