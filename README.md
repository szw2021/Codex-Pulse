# Codex Pulse

Codex Pulse 是一个轻量的 macOS 原生悬浮应用，用来快速查看本机 `codex_cli` 会话：

- 进行中：本轮任务尚未结束，并且 Codex 进程仍持有会话文件；
- 待确认：审批策略允许询问，存在未决命令/文件操作，且命令子进程尚未启动；
- 执行失败：收到错误/中止事件，或执行中的会话进程意外消失；
- 已完成：收到本轮 `task_complete` 事件。

每张会话卡片优先显示该会话最后一条用户提示词，便于直接识别最近任务；日志不可读或旧版本缺少对应事件时，才回退到数据库中的会话预览。

应用每 2 秒在本机读取 `~/.codex/state_5.sqlite`、`~/.codex/sessions/**/*.jsonl` 和相关进程文件句柄，不上传任何会话数据。列表展示最近 100 个顶层 CLI 会话，不包含内部子 Agent。

## 运行

要求：macOS 14+、Command Line Tools、已安装 Codex CLI。

```bash
./scripts/build-app.sh
open "dist/Codex Pulse.app"
```

启动后会出现一个置顶悬浮窗和菜单栏终端图标。隐藏窗口后可点击菜单栏图标重新打开。应用使用 Objective-C 原生壳与系统 WKWebView，不需要安装 Electron 或其他运行时。

首次点击“在终端中继续”时，macOS 可能请求允许 Codex Pulse 控制 Terminal。这个权限只用于执行 `codex resume <session-id>`。

## YOLO 模式

在右上角 `•••` 菜单中可以开启 YOLO 模式。该设置默认关闭并会保存在本机；开启后，“在终端中继续”和“复制继续命令”都会使用：

```bash
codex resume --dangerously-bypass-approvals-and-sandbox <session-id>
```

此参数会跳过所有确认并关闭 Codex 沙箱。Codex CLI 将其标记为“极度危险”，只应在工作目录已经由容器、虚拟机或其他机制可靠隔离时开启。

## 测试

```bash
./scripts/test.sh
```

## 实现边界

当前版本针对 Codex CLI `0.146.0` 验证。Codex 的 app-server 协议能提供精确的 `ThreadStatus`、`TurnStatus` 和审批请求，但独立启动的 CLI 进程不会自动把实时请求转发给另一个监控进程。因此，本应用对已有 CLI 会话采用只读本地检测：审批状态是根据未决工具调用、审批策略和命令子进程组合判断的。所有 Codex 数据访问都封装在 `CodexScanner` 中，CLI 内部格式变化时只需更新这个适配层。
