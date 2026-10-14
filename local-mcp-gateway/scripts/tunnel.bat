@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title Local MCP Tunnel

rem Use Windows PowerShell modules even when launched from PowerShell 7.
set "PSModulePath=%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules;%ProgramFiles%\WindowsPowerShell\Modules;%USERPROFILE%\Documents\WindowsPowerShell\Modules"

rem 普通启动会停止同一个 Tunnel 的旧实例，再加载当前已部署副本。
rem 编码选择 UTF-8（无 BOM），从仓库根目录的 tunnel.bat 启动。
rem 首次启动时隐藏输入密钥，随后使用 Windows DPAPI 加密保存。
rem 更换密钥：tunnel.bat /reset-key
rem 检查配置：tunnel.bat /check
rem 查看帮助：tunnel.bat /help
rem /check 检查已有 Tunnel 的真实轮询状态，或验证配置、网络及密钥。

set "LOCAL_MCP_LAUNCHER_FILE=%~f0"
set "LOCAL_MCP_LAUNCHER_MODE=%~1"
rem Configure tunnel_id in config/tunnel.local.json; never store an API key here.

rem 明确指定已安装的电脑控制服务配置目录。
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $text=[IO.File]::ReadAllText($env:LOCAL_MCP_LAUNCHER_FILE,[Text.Encoding]::UTF8); $parts=$text -split '(?m)^:__LOCAL_MCP_POWERSHELL__\r?$',2; if($parts.Count -ne 2){throw 'Launcher content is incomplete.'}; & ([ScriptBlock]::Create($parts[1]))"

set "LOCAL_MCP_EXIT_CODE=%ERRORLEVEL%"
echo.
echo Exit code: %LOCAL_MCP_EXIT_CODE%
pause
exit /b %LOCAL_MCP_EXIT_CODE%

:__LOCAL_MCP_POWERSHELL__
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

function Find-File([string[]]$Candidates) {
    foreach ($candidate in $Candidates) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and
            (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

function Read-PlainKey([Security.SecureString]$SecureKey) {
    $handle = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureKey)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($handle)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($handle)
    }
}

$mutex = $null
$ownsMutex = $false
$secureKey = $null
$plainKey = $null
$originalKey = $env:CONTROL_PLANE_API_KEY
$exitCode = 0

try {
    $repositoryRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $env:LOCAL_MCP_LAUNCHER_FILE))
    . (Join-Path $repositoryRoot 'shared\runtime-config.ps1')
    if (-not $env:LOCAL_MCP_RUNTIME_ROOT) { $env:LOCAL_MCP_RUNTIME_ROOT = Get-McpRuntimeRoot }
    if (-not $env:LOCAL_COMPUTER_CONTROL_STATE_DIR) { $env:LOCAL_COMPUTER_CONTROL_STATE_DIR = Join-Path $env:LOCAL_MCP_RUNTIME_ROOT '.runtime\local-computer-control' }
    $mode = ([string]$env:LOCAL_MCP_LAUNCHER_MODE).ToLowerInvariant()

    if ($mode -notin @('', '/reset-key', '/check', '/help')) {
        throw '支持的参数：/reset-key、/check、/help'
    }

    if ($mode -eq '/help') {
        Write-Host '双击先停止同一 Tunnel 的旧实例，再启动当前已部署副本；/reset-key 更换密钥；/check 仅检查网络、密钥和轮询状态。'
        exit 0
    }

    $tunnelId = $env:CONTROL_PLANE_TUNNEL_ID
    if (-not $tunnelId) { $tunnelId = $env:LOCAL_MCP_TUNNEL_ID }
    $localConfiguration = Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $env:LOCAL_MCP_LAUNCHER_FILE))) 'config\tunnel.local.json'
    $externalConfiguration = Get-McpConfigurationFile 'tunnel.local.json' $repositoryRoot
    if ($externalConfiguration) { $localConfiguration = $externalConfiguration }
    if (-not $tunnelId -and (Test-Path -LiteralPath $localConfiguration -PathType Leaf)) { $tunnelId = (Get-Content -LiteralPath $localConfiguration -Raw | ConvertFrom-Json).tunnel_id }
    if ($tunnelId -notmatch '^tunnel_[A-Za-z0-9]+$') {
        throw '请在 config/tunnel.local.json 填写 tunnel_id，或设置 LOCAL_MCP_TUNNEL_ID。'
    }

    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $mutex = [Threading.Mutex]::new(
        $false, ('Local\LocalMcpTunnel_{0}_{1}' -f $sid, $tunnelId)
    )

    try {
        $ownsMutex = $mutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }

    $running = @()
    try {
        $pattern = '(?<![A-Za-z0-9_])' +
            [regex]::Escape($tunnelId) + '(?![A-Za-z0-9_])'

        $running = @(
            Get-CimInstance Win32_Process -Filter "Name='tunnel-client.exe'" -OperationTimeoutSec 5 |
            Where-Object { [string]$_.CommandLine -match $pattern }
        )
    } catch {
        throw '无法确认已有 Tunnel 进程，未执行重启。请检查本机进程查询权限后重试。'
    }

    $batDirectory = Split-Path -Parent $env:LOCAL_MCP_LAUNCHER_FILE
    $startScript = Find-File @(
        (Join-Path $env:LOCAL_MCP_RUNTIME_ROOT 'local-mcp-gateway\scripts\start-chat-tunnel.ps1'),
        (Join-Path $batDirectory 'start-chat-tunnel.ps1'),
        (Join-Path $batDirectory 'local-mcp-gateway\scripts\start-chat-tunnel.ps1'),
        (Join-Path $batDirectory 'MCP\local-mcp-gateway\scripts\start-chat-tunnel.ps1')
    )

    if (-not $startScript) {
        throw '未找到统一入口的 start-chat-tunnel.ps1。请检查 LOCAL_MCP_RUNTIME_ROOT。'
    }

    $runtimeRoot = Split-Path -Parent (
        Split-Path -Parent (Split-Path -Parent $startScript)
    )

    if ($running.Count -gt 0 -and $mode -eq '/check') {
        . (Join-Path $runtimeRoot 'shared\tunnel-launch.ps1')
        Show-McpTunnelHealth -TunnelId $tunnelId -TunnelProcessId $running[0].ProcessId
        Write-Host ('已检测到正在运行的 Tunnel（PID：{0}），可能运行在后台或其他终端中。' -f $running[0].ProcessId)
        Write-Host '现有连接保持运行；当前窗口仅显示状态，关闭此窗口不会停止原进程。'
        exit 0
    }

    if (-not $ownsMutex -and $running.Count -eq 0) {
        Write-Host '另一个启动流程正在准备 Tunnel，尚未出现运行实例。本次不会并行启动。请稍后运行 /check。'
        exit 0
    }

    $desktopConfig = Join-Path $env:LOCAL_COMPUTER_CONTROL_STATE_DIR 'runtime.json'
    if (-not (Test-Path -LiteralPath $desktopConfig -PathType Leaf)) {
        Write-Warning ('未找到电脑控制运行配置：{0}。电脑控制暂不可用，文件与命令工具仍可启动。' -f $desktopConfig)
    }

    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1

    $nodeCandidates = @()
    if ($nodeCommand) {
        $nodeCandidates += $nodeCommand.Source
    }
    if ($env:ProgramFiles) {
        $nodeCandidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    }

    $nodePath = Find-File $nodeCandidates
    if (-not $nodePath) {
        throw '没有找到 Node.js，请先安装 Node.js 或修复 PATH。'
    }

    $clientCandidates = @(
        $env:TUNNEL_CLIENT_EXE,
        (Join-Path $runtimeRoot 'local-file-reader\bin\tunnel-client.exe')
    )

    $clientCommand = Get-Command tunnel-client.exe -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1

    if ($clientCommand) {
        $clientCandidates += $clientCommand.Source
    }

    $clientPath = Find-File $clientCandidates
    if (-not $clientPath) {
        throw '未找到 tunnel-client.exe，请安装官方客户端并设置 TUNNEL_CLIENT_EXE。'
    }

    $keyDirectory = Join-Path $env:LOCALAPPDATA 'SuperChatGPT\credentials'
    $keyFile = Join-Path $keyDirectory ($tunnelId + '.dpapi')

    if ($mode -eq '/reset-key') {
        $plainKey = $null
    } elseif (Test-Path -LiteralPath $keyFile -PathType Leaf) {
        try {
            $secureKey = ConvertTo-SecureString ([IO.File]::ReadAllText($keyFile).Trim())
            $plainKey = Read-PlainKey $secureKey
        } catch {
            if ($mode -eq '/check') {
                throw ('已保存的密钥读取失败：{0}。请在普通启动窗口内重新输入；检查模式不会请求密钥。' -f $_.Exception.Message)
            }
            Write-Host '已保存的密钥无法解密，请重新输入。'
        }
    }

    if ($mode -ne '/reset-key' -and
        [string]::IsNullOrWhiteSpace($plainKey) -and
        -not [string]::IsNullOrWhiteSpace($originalKey)) {
        $plainKey = $originalKey.Trim()
    }

    if ([string]::IsNullOrWhiteSpace($plainKey)) {
        if ($mode -eq '/check') {
            throw '未找到可用的已保存密钥。请先正常启动并隐藏输入 runtime API key；检查模式不会请求密钥。'
        }
        if ($secureKey) {
            $secureKey.Dispose()
            $secureKey = $null
        }

        $secureKey = Read-Host '请输入 tunnel runtime API key（输入隐藏）' -AsSecureString
        $plainKey = (Read-PlainKey $secureKey).Trim()

        if ([string]::IsNullOrWhiteSpace($plainKey) -or $plainKey -match '\s') {
            throw '密钥不能为空，也不能包含空格或换行。请重新启动并完整输入。'
        }

        New-Item -ItemType Directory -Path $keyDirectory -Force | Out-Null
        $normalized = ConvertTo-SecureString $plainKey -AsPlainText -Force

        try {
            $encrypted = ConvertFrom-SecureString $normalized
            [IO.File]::WriteAllText(
                $keyFile, $encrypted, [Text.UTF8Encoding]::new($false)
            )
        } finally {
            $normalized.Dispose()
        }

        Write-Host '密钥已按当前 Windows 账户加密保存。以后无需重复输入。'
    }

    if ($plainKey -match '\s') {
        throw '密钥包含空格或换行，请使用 /reset-key 重新输入。'
    }

    $env:CONTROL_PLANE_API_KEY = $plainKey

    if ($mode -ne '/check') {
        . (Join-Path $runtimeRoot 'shared\tunnel-launch.ps1')
        if ($running.Count -gt 0) {
            Stop-McpTunnelInstances -Instances $running -TunnelId $tunnelId -OwnerSid $sid -LauncherFile $env:LOCAL_MCP_LAUNCHER_FILE
        }
        if (-not $ownsMutex) {
            try { $ownsMutex = $mutex.WaitOne(10000) }
            catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
            if (-not $ownsMutex) {
                Write-Host '另一个窗口已接手重启，本次不会再创建一个实例。请运行 /check 查看状态。'
                exit 0
            }
        }
    }

    Write-Host ('统一入口：{0}' -f $startScript)
    Write-Host ('Tunnel：{0}' -f $tunnelId)
    Write-Host ('电脑控制配置：{0}' -f $desktopConfig)

    if ($mode -ne '/check') {
        Write-Host '启动后请保持此窗口打开。'
    }

    $parameters = @{
        TunnelId = $tunnelId
        TunnelClientPath = $clientPath
        NodePath = $nodePath
    }

    if ($mode -eq '/check') {
        $parameters.DoctorOnly = $true
    }

    & $startScript @parameters

    $nativeExit = Get-Variable LASTEXITCODE -ValueOnly -ErrorAction SilentlyContinue
    if ($null -ne $nativeExit) {
        $exitCode = [int]$nativeExit
    }
} catch {
    $exitCode = 1
    Write-Host ''
    Write-Host ('启动失败：{0}' -f $_.Exception.Message) -ForegroundColor Red
    Write-Host '可运行 /check 检查本机配置；更换密钥后运行 /reset-key。'
} finally {
    $env:CONTROL_PLANE_API_KEY = $originalKey
    $plainKey = $null

    if ($secureKey) {
        $secureKey.Dispose()
    }
    if ($ownsMutex) {
        $mutex.ReleaseMutex()
    }
    if ($mutex) {
        $mutex.Dispose()
    }
}

exit $exitCode
