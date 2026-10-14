# Super ChatGPT

Super ChatGPT 为支持 MCP 的客户端提供本地文件读写、办公文档编辑、命令执行、Windows 桌面控制和 Antigravity CLI 任务委派。所有功能共用一个网关入口，后端独立运行。

## 功能

| 功能 | 用途 |
| --- | --- |
| 文件读取与搜索 | 浏览目录，搜索内容，按页读取文本、常见文档和图片 |
| 文件写入与修改 | 创建、复制和精确替换文件；修改已有文件时校验 SHA256 并保留备份 |
| 文档编辑 | 编辑 DOCX、PDF、PPTX、XLSX 和 OpenDocument；旧版 Office、RTF 等格式通过 LibreOffice 转换 |
| 命令执行 | 在指定目录运行 PowerShell、Python、JavaScript 或可执行文件，查询输出、退出码并取消运行 |
| 电脑控制 | 观察屏幕和控件，操作鼠标、键盘、窗口与剪贴板，等待界面条件 |
| Antigravity Agent | 并行执行 CLI 任务，查询结果，排队或立即发送后续消息，打开独立进度窗口 |

默认提供 33 个工具：文件服务 18 个、电脑控制 6 个、Antigravity 8 个、网关状态 1 个。Antigravity CLI 需要单独安装和登录；未安装它不影响基础文件、文档、命令和桌面功能。普通文件操作直接使用文件工具，任务委派只在明确需要时使用。

## 安装

需要 Windows 10/11、Node.js 20.16 及以上版本、Python 3.12 及以上版本。将 Node.js 和 Python 加入 PATH，或通过 `SUPER_CHATGPT_PYTHON` 指定 Python 的绝对路径。安装时需要访问依赖下载源。

在仓库根目录打开 PowerShell：

```powershell
npm run setup
```

安装程序下载锁定版本的依赖并建立运行副本，默认位置为 `%LOCALAPPDATA%\SuperChatGPT`。`LOCAL_MCP_RUNTIME_ROOT` 可更换位置。文档编辑和电脑控制使用独立的 Python 环境，桌面后端使用 Python 3.14.8。

只安装基础文件和命令功能时：

```powershell
npm run setup -- -SkipComputerSetup -SkipDocumentSetup
```

LibreOffice 是可选组件，用于旧版文档转换；未被自动发现时，可设置 `LOCAL_FILE_READER_LIBREOFFICE` 为 `soffice.exe` 的绝对路径。

## 连接客户端

支持 stdio 的客户端可参考 [连接配置示例](config/mcp.example.json)。将示例中的目录改为本机绝对路径，启动命令为 `node`，入口为 `local-mcp-gateway/server.js`。

根目录的 `plugin.json`、`mcp.json` 和 `skills/` 用于支持相应插件格式的客户端。工具授权由客户端提供。网关使用 stdio；只接受 MCP 网址的客户端需要另行配置 HTTP 接口和授权服务。

### ChatGPT Tunnel

准备自己的 Tunnel ID、Runtime API key 和官方 `tunnel-client.exe`：

1. 将 `config/tunnel.example.json` 复制为 `config/tunnel.local.json`，填写自己的 `tunnel_id`。
2. 设置 `TUNNEL_CLIENT_EXE` 为客户端程序的绝对路径，或将其加入 PATH。
3. 双击根目录的 `tunnel.bat`，首次运行时隐藏输入密钥。
4. 在 Chat 中添加或刷新连接，按界面提示授予工具使用权限。

密钥使用当前 Windows 用户的 DPAPI 加密，保存在 `%LOCALAPPDATA%\SuperChatGPT\credentials`，不写入仓库。Tunnel ID 也可通过 `LOCAL_MCP_TUNNEL_ID` 或 `CONTROL_PLANE_TUNNEL_ID` 指定。

`tunnel.bat /check` 检查配置和连接，`tunnel.bat /reset-key` 更换密钥。普通启动会停止同一 Tunnel 的旧实例后重新启动，应在依赖该连接的工作结束后运行。

### ChatGPT HTTPS 接入（需另行配置）

也可以通过公开的 HTTPS MCP 地址连接 ChatGPT，无需 OpenAI Tunnel ID 和 Runtime API key。用户仍需具备添加和使用自定义 MCP 的权限，账号与工作区限制以 [ChatGPT 接入说明](https://developers.openai.com/api/docs/guides/custom-mcp-server) 为准。

当前仓库提供 stdio 网关；此路径需要另外配置 HTTP 适配层和认证服务，尚无随仓库提供的一键启动程序。文件、文档、命令和电脑控制后端可继续复用。

1. 部署支持 MCP Streamable HTTP 的适配层，将 `/mcp` 请求转发给本地 `local-mcp-gateway/server.js` 的 stdio 服务。本地 HTTP 接口绑定 `127.0.0.1`。
2. 配置与 ChatGPT 兼容的 OAuth 登录和授权，在服务端验证访问令牌及操作权限。OAuth 的发现、登录和令牌接口也需要能被相应客户端访问；文件写入、终端和桌面操作不应通过无认证的公开接口暴露。
3. 使用 MCP Inspector 检查初始化、工具列表、认证和一次只读调用，再通过 ngrok 等转发服务为 HTTP 接口取得 HTTPS 地址。
4. 在 ChatGPT 的 Plugins 页面选择 **Add custom MCP server**，填写带 `/mcp` 路径的 **Server URL**，配置 OAuth 并完成登录授权，创建并安装插件。
5. 在新对话中选用插件，先确认工具发现和只读调用正常，再使用需要授权的写入与桌面功能。

例如，适配层和认证已配置完成，HTTP 服务监听 `127.0.0.1:8787` 时，可运行：

```powershell
ngrok http 8787
```

将转发服务返回的地址加上 `/mcp`，例如 `https://<subdomain>.ngrok.app/mcp`，填入 ChatGPT。ngrok 负责转发 HTTP 请求，HTTP 接口和认证需先配置完成。第三方转发服务可能需要自己的账号或凭证。

使用期间保持本地服务和转发程序运行。HTTPS 地址变化后需更新连接；长期使用宜配置稳定地址。接口与转发流程见 [官方 HTTPS MCP 教程](https://developers.openai.com/plugins/build/app-quickstart)，OAuth 配置见 [认证说明](https://developers.openai.com/plugins/build/auth)。

## 使用

可以直接提出具体需求，例如读取代码、修改文件、编辑文档、执行测试或操作独立窗口。

文本编辑不限制扩展名，支持代码、Markdown、JSON、CSV 和配置文件等。替换已有文件前需要读取原内容和当前 SHA256；哈希不一致时应重新读取。PDF 以页面和区域为单位编辑，扫描件 OCR 和自动段落重排不在现有能力范围内。

命令使用当前 Windows 用户的权限运行。提交时使用唯一 `request_id`，保留 `execution_id`，通过 `get_local_execution` 查询状态和分页输出。每次等待最多 20 秒；丢失回执时使用原 ID 查询。

电脑控制需要已登录、未锁定的桌面。操作前取得租约和快照，使用标签时携带对应 `snapshot_id`，完成后释放租约。界面变化或执行结果不明时，先重新观察。详细流程见 [本地工具指引](skills/local-file-reader/SKILL.md)。

### Antigravity Agent

单独安装并登录 Antigravity CLI，将 `agy.exe` 加入 PATH，或设置 `AGY_EXECUTABLE`。插件也会检查 `%LOCALAPPDATA%\agy\bin\agy.exe`。需要使用其他 Python 时，设置 `ANTIGRAVITY_AGENT_PYTHON`。

通过 `execute_task` 提交任务，指定已有的工作目录并保留任务 ID。使用 `wait_task` 分次短等待，使用 `get_task` 获取完整结果。`send_task_message` 支持 `queue` 和 `send_now`；后者在工具边界中断当前输出并续接同一 CLI 会话。进度窗口可关闭或重新打开，关闭窗口不会取消任务。

默认最多同时运行 4 个任务，`ANTIGRAVITY_AGENT_MAX_CONCURRENT` 支持 1–32。默认模型为 `gemini-3.8-flash-high`，思考强度 `high`，模式 `accept-edits`，完全访问开启。可在任务参数中指定其他模型或限制权限；模型是否可用以 `capabilities` 和实际 CLI 账户为准。完全访问不会扩大任务范围，也不代表客户端已授权任务委派。

如需让 CLI 使用同一桌面服务，部署后运行 `local-computer-control/scripts/configure-antigravity.ps1`。它通过 CLI 配置 `local_computer_control`，保留其他 MCP 定义；遇到同名但不同的配置会停止。桌面租约由 Chat 和 CLI 共用。详细流程见 [Antigravity 指引](skills/antigravity-agent/SKILL.md)。

不需要 Antigravity 工具时，可在启动网关前设置 `ANTIGRAVITY_AGENT_ENABLED=0`，此时提供基础的 25 个工具。插件不会自行启动 CLI 任务。

## 配置与维护

个人配置、密钥、运行记录和文档备份不随仓库提交。可用 `LOCAL_MCP_CONFIG_DIR` 指定独立配置目录，也可使用仓库旁的 `user/config`。其中 `runtime.local.json` 指定本机运行目录和 Python，`tunnel.local.json` 指定 Tunnel ID，`workspace-policy.json` 和 `services.local.json` 用于本地组件配置。没有个人配置时使用通用默认值。

更新源码后重新运行 `npm run setup`，待当前工作结束后重启 Tunnel 并刷新工具。发布过程将需要的运行配置保存到运行副本，运行中的插件不依赖源码目录。

组件结构和故障处理见 [维护报告](MAINTENANCE.md)，第三方来源和许可见 [第三方说明](THIRD_PARTY_NOTICES.md)。
