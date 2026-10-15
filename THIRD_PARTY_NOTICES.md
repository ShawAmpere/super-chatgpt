# 第三方说明

## Windows-MCP

桌面后端使用 [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP) 0.8.7 的源码，来源提交为 `b455c2766c63599d466a6178641bac70787979a4`，许可为 MIT。

源码位于 `local-computer-control/vendor/windows-mcp`，包含输入、等待、窗口匹配和控件定位等本地修改，修改范围见 [维护报告](MAINTENANCE.md)。Python 包的 `pyproject.toml` 保留上游作者信息，`LICENSE` 保留完整许可并随包安装。

完整许可及版权声明见随源码保留的 [Windows-MCP LICENSE](local-computer-control/vendor/windows-mcp/LICENSE)。

## PyMuPDF

文档编辑环境安装 PyMuPDF 1.28.2，用于 PDF 内容校验及编辑脚本。PyMuPDF 和 MuPDF 采用 AGPL 与商业双许可；使用开源版本时需遵守其 AGPL 条款。项目自有代码的许可不替代这一依赖的许可。详见 [PyMuPDF 许可说明](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright)。

## 依赖与外部程序

Node 依赖的名称、版本、完整性哈希和声明许可记录在各组件的 `package-lock.json` 中。Python 依赖由 `local-file-reader/editor-requirements.txt` 和 `local-computer-control/requirements.lock` 固定；安装器取得依赖包及其自带许可。

主要依赖包括 MCP TypeScript SDK、文档解析库、python-docx、python-pptx、openpyxl、pypdf、PyMuPDF 和 ReportLab。各依赖沿用自己的许可，Windows-MCP 的 MIT 许可不适用于所有依赖。

LibreOffice、官方 Tunnel 客户端和 Antigravity CLI 由使用者单独安装，沿用各自的许可、账户要求与使用条款。仓库中的 Antigravity Agent 是 MCP 适配代码，不包含 Antigravity 客户端、CLI 二进制、账户凭据或模型服务。未安装该 CLI 时，基础文件、文档、命令和桌面工具仍可使用。

本项目自有源码的使用说明见 [源码使用](README.md#源码使用)。本说明中的第三方许可适用于对应的第三方内容。
