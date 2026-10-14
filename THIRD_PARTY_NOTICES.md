# 第三方说明

## Windows-MCP

桌面后端使用 [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP) 0.8.7 的源码，来源提交为 `b455c2766c63599d466a6178641bac70787979a4`，许可为 MIT。

源码位于 `local-computer-control/vendor/windows-mcp`，包含输入、等待、窗口匹配和控件定位等本地修改，修改范围见 [维护报告](MAINTENANCE.md)。Python 包的 `pyproject.toml` 保留上游作者信息，`LICENSE` 保留完整许可并随包安装。

### MIT 许可全文

```text
MIT License

Copyright (c) 2025 JEOMON GEORGE

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 依赖与外部程序

Node 依赖的名称、版本、完整性哈希和声明许可记录在各组件的 `package-lock.json` 中。Python 依赖由 `local-file-reader/editor-requirements.txt` 和 `local-computer-control/requirements.lock` 固定；安装器取得依赖包及其自带许可。

主要依赖包括 MCP TypeScript SDK、文档解析库、python-docx、python-pptx、openpyxl、pypdf、PyMuPDF 和 ReportLab。各依赖沿用自己的许可，Windows-MCP 的 MIT 许可不适用于所有依赖。

LibreOffice、官方 Tunnel 客户端和 Antigravity CLI 由使用者单独安装，沿用各自的许可、账户要求与使用条款。仓库中的 Antigravity Agent 是 MCP 适配代码，不包含 Antigravity 客户端、CLI 二进制、账户凭据或模型服务。未安装该 CLI 时，基础文件、文档、命令和桌面工具仍可使用。

项目自有代码尚未指定开源许可；本说明中的第三方许可适用于对应的第三方内容。
