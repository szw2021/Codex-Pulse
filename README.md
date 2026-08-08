# Codex Pulse

Codex Pulse 是一个轻量的 Electron 菜单栏悬浮应用，用来快速查看本机与远程服务器上的 `codex_cli` 会话：

- 进行中：本轮任务尚未结束，并且 Codex 进程仍持有会话文件；
- 待确认：审批策略允许询问，存在未决命令/文件操作，且命令子进程尚未启动；
- 执行失败：收到错误/中止事件，或执行中的会话进程意外消失；
- 已完成：收到本轮 `task_complete` 事件。

每张会话卡片优先显示该会话最后一条用户提示词，便于直接识别最近任务；日志不可读或旧版本缺少对应事件时，才回退到数据库中的会话预览。

应用每 2 秒在本机只读访问 `~/.codex/state_5.sqlite`、`~/.codex/sessions/**/*.jsonl` 和相关进程文件句柄，不上传任何会话数据。列表展示最近 100 个顶层 CLI 会话，不包含内部子 Agent。远程会话通过用户已经配置的 SSH 连接读取。

## 运行

要求：macOS 14+、Node.js 22+、已安装 Codex CLI。开发和构建前先安装依赖：

```bash
npm install
```

开发运行：

```bash
npm start
```

打包为可直接打开的 `.app`：

```bash
./scripts/build-app.sh
open "dist/Codex Pulse.app"
```

启动后会出现一个置顶悬浮窗和菜单栏终端图标。隐藏窗口后可点击菜单栏图标重新打开。打包后的应用已经包含 Electron 运行时，不要求目标机器另外安装 Node.js 或 Electron。

如需生成 Electron Forge 的 ZIP 分发包：

```bash
npm run make
```

`scripts/build-app.sh` 默认使用 npmmirror 下载首次打包所需的 Electron 运行时；如需改回官方源，可在执行前设置自己的 `ELECTRON_MIRROR`。

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
# 或 npm test
```

测试覆盖状态判定、提示词提取、完成确认、命令转义、SSH 配置解析与本机数据库集成扫描。

## 精简 Codex 会话

项目配置会自动关闭本项目不使用的 MCP。通过下面的入口启动 Codex，还会仅保留与本项目有关的文档查询 skills：

```bash
./scripts/codex-project.sh
```

Codex 子命令和参数可以照常追加，例如：

```bash
./scripts/codex-project.sh resume <session-id>
```

## 实现边界

当前版本针对 Codex CLI `0.146.0` 验证。Codex 的 app-server 协议能提供精确的 `ThreadStatus`、`TurnStatus` 和审批请求，但独立启动的 CLI 进程不会自动把实时请求转发给另一个监控进程。因此，本应用对已有 CLI 会话采用只读本地检测：审批状态是根据未决工具调用、审批策略和命令子进程组合判断的。所有本地数据访问都封装在 `src/main/codex-scanner.js` 中，远程适配层位于 `src/main/remote-scanner.js` 与 `src/remote/remote_scanner.py`。

Electron 渲染进程不启用 Node.js，主进程能力只通过 `preload` 中白名单化的 `contextBridge` API 暴露；窗口也禁止新窗口和外部导航。
