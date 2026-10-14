# 维护报告

## 组件结构

| 组件 | 版本 | 职责 |
| --- | --- | --- |
| Local MCP Gateway | 0.4.9 | 提供统一 MCP 入口，限制工具列表，维护后端连接和发现缓存 |
| Antigravity Agent | 0.6.4 | CLI 任务、并发控制、消息续接、结果持久化和进度窗口 |
| Local File Reader | 0.3.5 | 文件浏览、检索、读写、文档处理和本地命令执行 |
| Local Computer Control | 0.2.7 | 桌面观察、输入、窗口管理、条件等待和共享租约 |
| Shared | 1.1.6 | 运行路径、跨进程锁、辅助进程、发布恢复和完整性检查 |

网关默认提供 33 个工具：文件服务 18 个、电脑控制 6 个、Antigravity 8 个、网关状态 1 个。后端独立连接；某一后端异常时，其余服务可继续使用。Antigravity CLI 只在明确调用时使用，工具发现不会启动模型任务。设置 `ANTIGRAVITY_AGENT_ENABLED=0` 可关闭其工具。电脑控制的 Broker 按需启动，并在同一运行目录下协调桌面使用。

默认组件清单位于 `shared/workspace-policy.default.json`。独立配置目录中的 `workspace-policy.json` 可覆盖组件清单，`services.local.json` 可接入额外服务。扩展受名称、工具白名单和版本兼容检查约束；服务配置只在进程启动时读取。Antigravity 已属于标准组件，无需重复添加本地服务定义。

仓库保存运行源码、安装资产、使用指引和三份项目文档。个人配置与运行数据独立保存；`.gitignore` 排除密钥、依赖目录、运行状态和本地记录。发布时使用实际组件清单，并对独立配置采用相同的哈希校验、暂存和恢复流程。

安装和更新由 `scripts/setup.ps1`、`local-mcp-gateway/scripts/update-runtime.ps1` 及 `shared/deploy-runtime.ps1` 负责。组件通过相邻目录导入共享代码，发布时需要保持五个组件的目录关系。

## 运行与数据

`LOCAL_MCP_RUNTIME_ROOT` 指定运行副本位置，默认是 `%LOCALAPPDATA%\SuperChatGPT`。`.runtime` 保存状态、备份和 Python 环境，`.releases` 保存受管发布及恢复材料。源码、运行副本和运行数据具有不同用途，应分别维护。

`LOCAL_MCP_CONFIG_DIR` 指定独立配置目录，默认也支持仓库旁的 `user/config`。个人路径和 Tunnel 信息不应写入默认源码或示例。发布器将运行所需的本地配置纳入受管发布，保留运行副本的独立性；API key 仍通过环境或 DPAPI 凭据读取。

更新依据锁文件和受管文件清单判断变化。发布失败时保留恢复记录；再次运行统一更新入口可恢复或继续发布。更新过程中检测到受管文件的外部修改时，会停止覆盖并报告冲突。

`get_gateway_status` 可查询连接和部署状态。`verify_integrity:true` 校验受管运行文件的 SHA256，`verify_dependencies:true` 检查依赖版本及关键依赖文件。`consistent` 表示发布元数据一致，只有深度检查才核验文件内容。源码目录尚未发布时，`untracked` 为正常状态。

运行副本中的 `local-mcp-gateway/scripts/check-runtime.ps1` 提供只读环境诊断，使用 `-Storage` 可查看发布备份和文件编辑备份的占用。文件恢复材料不自动删除；受管发布历史按数量和容量策略保留，未完成恢复或存在用户修改的目录受到保护。

## 可靠性机制

文件写入先暂存，再校验目标版本并发布。已有文件的修改要求 `expected_sha256`，原内容保存为备份。命令和文档作业通过持久化 `request_id` 去重；结果不明时查询原作业状态，服务不会自动重放写入或命令。

Agent 使用 Windows Job Object 管理 CLI 进程树，活动索引和消息队列持久化。任务提交和后续消息均支持 `request_id` 去重。`send_now` 保留会话并在工具边界续接，执行状态不明时不创建替代任务。取消、异常回收和服务关闭只处理受管任务。近期索引减少历史遍历，`antigravity-agent/scripts/archive-tasks.mjs` 提供显式归档，归档结果仍可查询。

文件检索默认排除依赖和构建目录，显式全量检索可关闭默认排除。大文本使用流式读取和字节游标；文档解析使用有时间、内存和压缩展开限制的独立进程。游标、分页和输出预算只限定单次结果，完整读取需要继续获取剩余内容。

桌面操作在共享队列中执行，并验证租约、快照身份、目标窗口、控件 RuntimeId 和遮挡状态。未知或部分执行会使旧观察失效。长文本优先使用粘贴路径；不支持安全恢复的剪贴板格式会在输入前拒绝操作。桌面租约用于协作，不能替代独立的用户认证。

## Windows-MCP 本地修改

桌面后端基于 Windows-MCP 0.8.7。来源与完整许可见 [第三方说明](THIRD_PARTY_NOTICES.md)。Broker 从仓库中的 `vendor/windows-mcp/src` 加载后端代码，Python 环境提供其依赖。

以下路径相对于 `local-computer-control/vendor/windows-mcp/src/windows_mcp/`：

| 修改范围 | 主要文件 | 维护要点 |
| --- | --- | --- |
| 条件等待 | `tools/input.py`、`tools/wait_poll.py` | 区分条件未满足、探测失败和接口超时 |
| 窗口与控件树 | `desktop/window_metadata.py`、`desktop/window_match.py`、`desktop/service.py`、`tools/snapshot.py`、`tools/_snapshot_helpers.py` | 精确标题优先；保留真实候选、前台身份和控件树目标 |
| 标签与定位 | `tree/service.py`、`tools/input.py` | 保留标签索引、启用状态、原窗口和 RuntimeId；拒绝陈旧或遮挡目标 |
| 文本与剪贴板 | `desktop/clipboard_text.py`、`desktop/input_result.py`、`desktop/service.py` | 保留 Unicode、多行清空、剪贴板回滚和执行状态诊断 |
| 多步骤输入 | `desktop/service.py`、`desktop/input_result.py` | 记录部分执行，异常后释放拖动输入，避免重复操作 |
| 程序启动与线程上下文 | `tools/app.py`、`infrastructure/thread_affinity.py` | 支持 PATH 查找和原样参数，保持控制上下文传递 |

升级上游前应对照记录的提交核查这些修改。直接覆盖 vendored 目录可能丢失输入、等待和定位保护。

## 依赖与功能检查

Node 依赖由各组件的 `package-lock.json` 固定；文档编辑依赖见 `editor-requirements.txt`，桌面依赖见 `requirements.lock`。更新依赖时同步更新锁文件，重新安装对应环境，再检查受影响的功能。桌面依赖安装器同时检查 vendored 源码的哈希。

维护后的功能检查宜使用独立工作目录和测试窗口：确认工具数量与白名单，检查文件读取、编码和哈希冲突处理；修改文档后核对内容与版式；执行命令后检查退出码、去重和取消；桌面操作需核对真实应用状态，并检查窗口切换和布局变化后的重新定位。Agent 还需检查并发、消息队列、续接、去重、进程回收和未安装 CLI 时的基础功能。

LibreOffice 转换可能改变旧版文档的版式。PDF 使用页面和区域编辑。Electron、混合 DPI 多显示器及数小时的跨应用工作流仍需在目标环境确认兼容性。客户端推理、网络和界面呈现时间与本地服务耗时不同，应分别记录。

连接异常时先检查 `get_gateway_status`、`tunnel.bat /check` 和对应运行日志。长期运行的命令可分次短等待查询；服务终止不会自动恢复命令。关闭或重启连接前，应确认依赖该连接的工作已结束。
