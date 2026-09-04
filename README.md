# Codex Pulse

Codex Pulse 是一个基于 Tauri 的轻量 macOS 菜单栏应用，用来集中查看本机与远程服务器上的 Codex CLI 与 Claude Code 会话：

- 正在进行：本轮任务尚未结束，并且 Codex 进程仍持有会话文件；
- 等待处理：存在等待选择、审批或确认的工具调用；
- 新完成：任务刚刚完成，保留到点击“已查看”；
- 执行失败：收到错误/中止事件，或运行中的会话意外停止。

应用默认显示会话最后一条用户提示词，也可以在右上角菜单切换为原始标题。关注页按“进行中 / 新完成 / 失败”的配置数量控制窗口高度，多余内容自动隐藏并可切换到对应分类查看。

单击本地会话会直接打开它：仍在运行的 Terminal 或 iTerm2 会按 TTY 精确切回原标签页，已结束的会话会在 Terminal 中恢复。会话详情改由悬停后的 ⓘ 按钮打开，其中提供重命名和删除入口。远程运行中的会话因无法从服务器反向定位本机终端，仍需回到原 SSH 窗口处理。

带刘海的 Mac 可以在右上角菜单开启“刘海状态浮层”。应用使用 AppKit 读取屏幕安全区域，只在会话状态变化时从刘海下方展开提示，并在约 6 秒后自动收起；悬停会暂停收起，点击会打开主窗口。该功能是 Codex Pulse 自绘的原生浮动窗口，不是 macOS 系统灵动岛，无刘海屏幕会自动隐藏。

本地会话每 2 秒只读扫描一次，远程服务器每 15 秒通过已有 SSH 配置扫描一次。应用不会上传会话数据，也不会持有 Codex 的 SQLite 数据库或 JSONL 会话文件。

## 运行

要求：macOS 14+、Node.js 22+、Rust stable、已安装 Codex CLI。

```bash
npm install
npm start
```

通过 Homebrew 安装 `rustup` 时，需要确保工具链目录位于 PATH：

```bash
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
```

## 打包

生成可直接打开的 `.app`：

```bash
npm run package
```

生成 DMG 安装包：

```bash
npm run make
```

产物位于：

```text
src-tauri/target/release/bundle/macos/Codex Pulse.app
src-tauri/target/release/bundle/dmg/Codex Pulse_0.2.0_aarch64.dmg
```

也可以使用 `./scripts/build-app.sh` 将 `.app` 复制到 `dist/Codex Pulse.app`。

首次点击会话或“在终端中继续”时，macOS 可能请求允许 Codex Pulse 控制 Terminal 或 iTerm2。此权限只用于定位原终端标签页，或执行 `codex resume <session-id>` / `claude --resume <session-id>`。

## YOLO 模式

右上角菜单可以开启 YOLO 模式。该设置默认关闭并保存在本机；开启后，继续命令会使用：

```bash
codex resume --dangerously-bypass-approvals-and-sandbox <session-id>
claude --resume <session-id> --dangerously-skip-permissions
```

此参数会跳过确认并关闭沙箱，只应在工作目录已经可靠隔离时开启。

## 测试

```bash
npm test
npm run check
```

测试覆盖状态判定、提示词提取、完成确认、命令转义、设置迁移、SSH 配置解析和远程数据规范化。

## 实现边界

独立运行的 Codex CLI 不会把实时 app-server 事件转发给监控进程，因此 Codex Pulse 采用只读检测：结合 JSONL 事件、审批策略、会话文件占用和子进程状态判断任务状态。

Claude Code 2.1.139+ 优先通过 `claude agents --json` 按会话 ID 读取运行、等待和空闲状态；旧版本或命令不可用时，再解析 `~/.claude/projects` 下的 `last-prompt`、`turn_duration` 等回合边界记录，并以进程工作目录作为兼容回退。Claude 会话暂不支持重命名与删除。

本地扫描与状态管理位于 `src-tauri/src/`，远程适配会把 `src/remote/remote_scanner.py` 编译进 Rust 二进制，并通过 SSH 标准输入发送到服务器执行，不在远程服务器写入脚本文件。远程机器上只装 Codex 或只装 Claude 都可以正常扫描。
