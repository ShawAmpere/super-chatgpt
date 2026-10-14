# Super ChatGPT

Super ChatGPT 为支持 MCP 的客户端提供本地文件读写、办公文档编辑、命令执行和 Windows 桌面控制。一个网关连接文件服务和电脑控制服务，共提供 25 个工具。

## 功能

| 功能 | 用途 |
| --- | --- |
| 文件读取与搜索 | 浏览目录，搜索内容，按页读取文本、常见文档和图片 |
| 文件写入与修改 | 创建文件、复制完整文件、按原文精确替换；修改已有文件时校验 SHA256 并保留备份 |
| 文档编辑 | 使用本地格式库编辑 DOCX、PDF、PPTX、XLSX 和 OpenDocument；旧版 Office、RTF 等格式通过 LibreOffice 转换 |
| 命令执行 | 在指定工作目录运行 PowerShell、Python、JavaScript 或可执行文件，查询输出和退出码，取消运行 |
| 电脑控制 | 观察屏幕和控件，操作鼠标、键盘、窗口与剪贴板，等待界面条件 |

## 安装

需要 Windows 10/11、Node.js 20.16 及以上版本、Python 3.12 及以上版本。将 Node.js 和 Python 加入 PATH，或通过 `SUPER_CHATGPT_PYTHON` 指定 Python 的绝对路径。安装时需要访问 npm、PyPI 和 Python 下载源。

在项目根目录打开 PowerShell：

```powershell
npm run setup
```

安装程序会下载锁定版本的依赖，并建立运行副本。默认位置为 `%LOCALAPPDATA%\SuperChatGPT`；设置 `LOCAL_MCP_RUNTIME_ROOT` 可以更换位置。文档编辑和电脑控制各自使用独立的 Python 环境，其中桌面后端使用 Python 3.14.8。

只安装基础文件和命令功能时：

```powershell
npm run setup -- -SkipComputerSetup -SkipDocumentSetup
```

LibreOffice 是可选组件，用于旧版 Office、RTF 等格式转换。安装后若未被自动发现，可设置 `LOCAL_FILE_READER_LIBREOFFICE` 为 `soffice.exe` 的绝对路径。

## 连接客户端

### 本地 MCP

支持 stdio 的客户端可参考 [连接配置示例](config/mcp.example.json)，将示例中的项目目录改为本机绝对路径。网关入口为 `local-mcp-gateway/server.js`，启动命令为 `node`。

根目录的 `plugin.json`、`mcp.json` 和 `skills/` 用于支持相应插件格式的客户端。具体导入方式和工具授权由客户端提供。当前网关使用 stdio；只接受 MCP 网址的客户端需要另行配置 HTTP 接口和授权服务。

### ChatGPT Tunnel

先准备自己的 Tunnel ID、Runtime API key 和官方 `tunnel-client.exe`。然后：

1. 将 `config/tunnel.example.json` 复制为 `config/tunnel.local.json`，填写 `tunnel_id`。
2. 设置 `TUNNEL_CLIENT_EXE` 为客户端可执行文件的绝对路径，或将其加入 PATH。
3. 双击根目录的 `tunnel.bat`，首次运行时隐藏输入密钥。
4. 在 Chat 中添加或刷新对应连接，按界面提示授予工具使用权限。

密钥使用当前 Windows 用户的 DPAPI 加密，保存在 `%LOCALAPPDATA%\SuperChatGPT\credentials`。本地 JSON 仅存放 Tunnel ID。也可使用 `LOCAL_MCP_TUNNEL_ID` 或 `CONTROL_PLANE_TUNNEL_ID` 环境变量指定 ID。

`tunnel.bat /check` 检查配置和连接，`tunnel.bat /reset-key` 更换密钥。普通启动会停止同一 Tunnel 的旧实例后重新启动，应在依赖该连接的工作结束后运行。

## 使用

可在客户端中提出具体需求，例如：

- 读取指定目录中的代码，搜索函数并说明调用关系。
- 在指定文件中替换一段文本，保留原有编码和换行方式。
- 修改一份 Word 文档或演示文稿，并检查保存后的内容和版式。
- 在指定工作目录执行命令，返回退出码和输出。
- 在独立窗口中输入文本，观察操作结果后关闭窗口。

文本编辑不限制扩展名，支持代码、Markdown、JSON、CSV 和配置文件等。替换已有文件前需要读取原内容和当前 SHA256；哈希不一致时应重新读取。PDF 编辑以页面和区域为单位，扫描件 OCR 和自动段落重排不在现有能力范围内。

命令使用当前 Windows 用户的权限运行。每次提交使用唯一 `request_id`，保留返回的 `execution_id`，通过 `get_local_execution` 查询进度和输出。一次等待最多 20 秒；丢失回执时使用原 ID 查询。

电脑控制需要已登录、未锁定的桌面。操作前取得租约和快照，使用标签时携带对应 `snapshot_id`，完成后释放租约。界面变化或执行结果不明时，先重新观察。详细工具调用流程见 [插件使用指引](skills/local-file-reader/SKILL.md)。

## 更新与维护

更新源码后重新运行 `npm run setup`，待当前工作结束后重启 Tunnel 并刷新工具。文件备份、命令记录、桌面状态和密钥保存在运行目录或用户数据目录中，与源码分开。

组件结构、依赖更新和故障处理见 [维护报告](MAINTENANCE.md)，第三方来源和许可见 [第三方说明](THIRD_PARTY_NOTICES.md)。
