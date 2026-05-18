[English](README.md) · [한국어](README.ko.md) · **中文** · [日本語](README.ja.md)

[![npm](https://img.shields.io/npm/v/open-claude-p.svg)](https://www.npmjs.com/package/open-claude-p)
[![downloads](https://img.shields.io/npm/dm/open-claude-p.svg)](https://www.npmjs.com/package/open-claude-p)
[![stars](https://img.shields.io/github/stars/empty-user77/open-claude-p.svg)](https://github.com/empty-user77/open-claude-p/stargazers)
[![License](https://img.shields.io/npm/l/open-claude-p.svg)](https://github.com/empty-user77/open-claude-p/blob/main/LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ec1c8a?logo=github)](https://github.com/sponsors/empty-user77)

---

# open-claude-p (ocp)

一个基于 PTY 的兼容层，通过 **node-pty** 直接驱动交互式 `claude` CLI，在无法使用 `claude -p`（无头打印模式）的环境中提供相同的功能。

> **核心区别**：`claude -p` 是 Claude Code 的非交互模式，通过内部 API 运行，但在特定订阅/环境中不可用。`open-claude-p` 通过 PTY 运行实际的 TUI 客户端，并解析输出流以获得相同的结果。

**版本历史**：参见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 目录

- [安装](#安装)
- [推荐一次性配置](#推荐一次性配置)
- [与 `claude -p` 的已知差异](#与-claude--p-的已知差异)
- [CLI 用法](#cli-用法)
- [守护进程（会话持久化）](#守护进程会话持久化)
- [库 API](#库-api)
  - [createDriver()](#createdriveropts)
  - [runOneShot()](#runoneshotreq)
  - [返回值：OneShotResult](#返回值oneshotresult)
  - [事件类型（onEvent 回调）](#事件类型onevent-回调)
- [会话管理](#会话管理)
- [使用 JSONL 会话文件](#使用-jsonl-会话文件)
- [关于输出解析](#关于输出解析)
- [环境变量](#环境变量)
- [完整选项参考](#完整选项参考)
- [示例应用](#示例应用)

---

## 安装

### npm

```bash
# 作为项目依赖安装
npm install open-claude-p

# 或全局安装，以便在任意位置使用 `ocp` CLI
npm install -g open-claude-p
```

### 从源码安装（开发用）

```bash
# clone 后在项目根目录创建符号链接
git clone https://github.com/empty-user77/open-claude-p.git
cd open-claude-p
npm link

# 或从其他项目通过本地路径安装
npm install /path/to/open-claude-p
```

**前提条件**：`claude` CLI 必须已安装并在 `PATH` 中可用。

```bash
# 验证 Claude Code CLI 安装
claude --version
```

---

## 推荐一次性配置

**1.1+ 无需任何配置。** CLI 默认值已经是 permissive：
文件夹信任对话框自动接受 ON，`--dangerously-skip-permissions` ON。
`npm install -g open-claude-p` 之后直接 `ocp "..."` 就能工作。

如果你想恢复 claude 的常规权限提示（PTY 自动化无法回答，所有工具调用
都会 hang），用 opt-out 环境变量关闭：

```bash
export OCP_NO_AUTO_ACCEPT_TRUST=1   # "Do you trust this folder?" 对话框时 abort
export OCP_NO_SKIP_PERMS=1          # 恢复 claude 的常规权限提示
```

> ⚠️ 在默认 CLI 设置下，`ocp "…"` 调用一次就能按 prompt 内容执行 Bash、
> Write、Edit 等工具，且不需要任何确认。这对个人工作站和操作员亲自撰写
> prompt 的受控服务账号是合适的，但绝对不能在**不可信输入**（公开 chatbot、
> 易受 prompt injection 影响的 RAG 等）会混入 prompt 的地方原样使用。
> 应通过 `--allowed-tools`、`OCP_NO_SKIP_PERMS=1` 或每次调用前的验证来
> 缩小表面。
>
> 库默认值（`createDriver` / `createChatClient`）仍然保守 — 库调用方
> 必须显式 opt-in 权限跳过。

完整环境变量列表见 [docs/cli-reference.md](./docs/cli-reference.md)。

---

## 与 `claude -p` 的已知差异

`ocp` 是 argv 兼容的 shim，并非 `claude -p` 的逐字节等价替代。以下场景
即使使用相同参数，行为也会不同 — 集成到 consumer 流水线之前请预先考虑：

- **对 `~/.claude.json` 状态敏感。** PTY 层在每次 spawn 时都会渲染完整的
  TUI 横幅，包括 "1 MCP server needs auth · /mcp"、"auto mode unavailable"、
  插件更新提示等。`claude -p` 不画这些，但 `ocp` 经过画面层。本身不会触发
  abort（要等到 `⏺` 或 spinner 事件出现），但通知流量过多时
  first-response latency 可能超过 `OCP_FIRST_RESPONSE_MS`（默认 20s），
  产生 spurious 的 `interactive-required` abort。把这个 env 调大，或者从
  `~/.claude.json` 移除不用的 MCP/插件条目。

- **>1KB 的 prompt 走 chunked write 路径。** 单次多 KB write 会触发
  claude 的 paste 检测，结尾 CR 被当成 paste content 消化，prompt 永远
  不会被提交 — 这是 1.1 之前的回归。1.1+ 在大约 256 字符为单位、间隔
  短暂 delay 地分块写入 — 增加 50–500 ms first-byte latency。需要旧行为
  用 `OCP_PASTE_MODE=raw`；想完全绕开 TUI 输入框用 `--input-format=stream-json`。

- **会话持久化默认开启。** 每轮都会向 `~/.claude/projects/<encoded-cwd>/`
  写一个 JSONL 会话文件。对每轮在服务端重建上下文的 stateless 集成，应
  设置 `OCP_NO_SESSION_PERSISTENCE=1`（或 `--no-session-persistence`）。
  否则 dead 会话文件会堆积，`--continue` 查找可能选中无关的邻居文件。

- **守护进程会比调用方活得更久。** `~/.ocp/d-<hash>.sock` 上分离守护进程
  以便同一 cwd 后续调用跳过 2.5s warmup。空闲 `OCP_DAEMON_IDLE_MS`
  （默认 10 分钟）后自动退出。期望"子进程跟父进程一起死"的 consumer
  应用应使用 `OCP_NO_DAEMON=1` 或缩短 idle 超时。

- **Print mode（`--print-mode` / `OCP_PRINT_MODE=1`）是唯一完全绕开 PTY
  的路径**，本质上是 `claude --print` + argv 透传。MCP servers、工具
  授权提示和其他交互界面在此模式下都不可用 — 仅用作 fallback 或上游
  parity 测试。

- **Abort 时输出适配器不传 PTY 噪声。** 当 completionReason 是
  `timeout` / `interactive-required` / `trust-required` / `cancelled` /
  `write-failed` / `upstream-exited` 之一时，`text` 和 `stream-json` 适配器
  不再把累积的 PTY 内容当作模型回复 emit。`stream-json` 仅 emit
  `result.subtype=error` + `completion=<reason>`，stderr 简短错误消息中
  会包含模式匹配检测出的 `detected: <kind>` 提示。这与 `claude -p` 静默
  失败或回显当时缓冲文本的行为不同。

---

## CLI 用法

该包安装单个二进制文件 **`ocp`**。

```bash
# 基本用法
ocp "你好"

# 支持与 claude -p 相同的 argv 格式（-p 标志为兼容性被忽略）
ocp -p "你好"

# 从 stdin 读取提示
echo "北京今天天气怎么样？" | ocp

# 指定输出格式
ocp --output-format json "一个词回答：苹果"
ocp --output-format stream-json "你好"

# 指定模型
ocp --model sonnet "复杂问题..."
ocp --model claude-opus-4-7 "架构评审..."

# 添加系统提示
ocp --append-system-prompt "始终用中文回答" "what's the weather?"

# 恢复会话 — sessionId 会打印到 stderr
SID=$(ocp "只说奇异果" 2>&1 >/dev/null | grep sessionId | grep -oE '[0-9a-f-]{36}')
ocp --resume "$SID" "你刚才说了什么？"

# 或自动继续最近的会话
ocp --continue "你刚才说了什么？"

# 跳过权限检查（用于自动化环境）
ocp --dangerously-skip-permissions "读取并分析文件"
```

### 输出格式

#### `text`（默认）

```
你好！有什么我可以帮助您的？
```

#### `json`

```json
{
  "result": "你好！有什么我可以帮助您的？",
  "session_id": "a1b2c3d4-...",
  "is_error": false,
  "cost_usd": null,
  "duration_ms": 4200,
  "num_turns": 1
}
```

#### `stream-json`（NDJSON）

响应逐行流式传输：

```jsonl
{"type":"system","subtype":"init","session_id":"a1b2c3d4-...","tools":[],"mcp_servers":[]}
{"type":"assistant","session_id":"a1b2c3d4-...","message":{"role":"assistant","content":[{"type":"text","text":"你好！"}]}}
{"type":"result","subtype":"success","session_id":"a1b2c3d4-...","is_error":false,"duration_ms":4200}
```

---

## 守护进程（会话持久化）

`ocp` CLI 默认通过**后台守护进程**保持 PTY 会话存活。  
这意味着在同一目录中重复调用时无需等待 2.5 秒的预热，对话上下文会自动保留。

```
ocp "第一个问题"    → 如果没有守护进程则启动新的，有则复用
ocp "第二个问题"    → 连接到同一守护进程，上下文保留
```

守护进程 socket 存储在 `~/.ocp/` 下，**每个工作目录一个**。

### 禁用守护进程

```bash
OCP_NO_DAEMON=1 ocp "只运行一次"   # 直接启动 PTY，不使用守护进程
```

应跳过守护进程的情况：
- 使用 `--resume`、`--continue` 或 `--fork-session` 标志时（自动切换到直接模式）
- 使用 `--input-format=stream-json` 时
- 在 CI/CD 等隔离环境中单次执行时

### 守护进程环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OCP_NO_DAEMON` | 设为 `1` 时禁用守护进程 | — |
| `OCP_DAEMON_IDLE_MS` | 空闲此时间后自动终止守护进程 | `600000`（10 分钟） |
| `OCP_MAX_DAEMONS` | 同时保持的最大守护进程数 | `30` |

---

## 库 API

### `createDriver(opts?)`

创建驱动器。在整个应用程序中共享单个驱动器实例。

```js
import { createDriver } from 'open-claude-p';

const driver = createDriver({
  claudeBin:      'claude',     // claude 二进制路径（默认：PATH 中的 claude）
  warmupMs:       2500,         // PTY 初始化等待时间（ms）
  reuseWarmupMs:  200,          // 从池中复用时的等待时间（ms）
  idleMs:         1500,         // 响应完成后的静默等待（ms）
  preIdleMs:      8000,         // sentinel 匹配前的最小等待（ms）
  maxResponseMs:  60_000,       // 最大响应等待时间（ms），超时则结束
  poolSize:       0,            // PTY 池大小（0=禁用，N>0=保持 N 个预热）
  poolMaxAgeMs:   600_000,      // 池会话最大生命周期（ms）
  cwd:            process.cwd(), // 工作目录
  env:            {},           // 附加环境变量
  debug:          false,        // 将调试日志打印到 stderr
});
```

### `runOneShot(req)`

向 Claude 发送单个提示并等待响应。

```js
const result = await driver.runOneShot({
  prompt: '北京现在的天气怎么样？',

  // ── 模型 / 行为 ──────────────────────────────
  model: 'sonnet',                        // 模型名称
  effort: 'high',                         // 'low' | 'medium' | 'high' | 'max'
  thinking: 'adaptive',                   // 'enabled' | 'adaptive' | 'disabled'
  maxTurns: 5,                            // 最大代理轮次（shim 强制）

  // ── 系统提示 ──────────────────────────────────
  systemPrompt: '你是天气专家',            // 替换整个系统提示
  appendSystemPrompt: '始终用中文回答',    // 追加到默认提示

  // ── 权限 / 工具 ──────────────────────────────
  dangerouslySkipPermissions: true,        // 跳过权限检查
  allowedTools: ['WebSearch', 'Read'],     // 工具白名单
  disallowedTools: ['Bash'],               // 工具黑名单

  // ── 会话 ──────────────────────────────────────
  resume: 'a1b2c3d4-...',                  // 从之前的会话 UUID 恢复
  continue: false,                         // 继续最近的会话
  forkSession: false,                      // 恢复时创建新的会话 ID

  // ── 工作目录 ──────────────────────────────────
  cwd: '/path/to/project',

  // ── 取消 ──────────────────────────────────────
  abortSignal: controller.signal,

  // ── 实时事件回调 ──────────────────────────────
  onEvent(ev) {
    // 响应生成时实时调用
    // 参见下方"事件类型"章节
    if (ev.type === 'assistant-text') {
      process.stdout.write(ev.text);
    }
  },
});
```

### 返回值：OneShotResult

`runOneShot()` resolve 时返回如下结构的对象：

```ts
{
  // ── 核心结果 ────────────────────────────────────────────────────
  text: string,
  // Claude 的最终响应文本（已去除 TUI 残留）。
  // Claude 生成的原始文本——markdown、HTML、代码块等。
  // 渲染/解析由调用方负责。

  sessionId: string | null,
  // 本次请求对应的 Claude 会话 UUID。
  // 使用 --resume <sessionId> 可继续对话。
  // 如果 banner 捕获失败，将回退到 ~/.claude/projects/ 文件系统扫描。

  isError: boolean,
  // true = 因错误或超时完成

  completionReason: string,
  // 完成原因：
  //   'sentinel'         正常完成（检测到 sentinel 字符串）
  //   'idle'             响应后静默超时
  //   'prompt-box'       TUI 输入框重新出现
  //   'timeout'          超过 maxResponseMs
  //   'max-turns'        达到 maxTurns 限制
  //   'upstream-exited'  claude 进程先退出
  //   'write-failed'     PTY 写入失败
  //   'cancelled'        通过 AbortSignal 取消

  exitCode: number,
  // 0 = 成功，1 = 错误

  // ── 事件数组 ────────────────────────────────────────────────────
  events: Array<object>,
  // 管道产生的所有事件（与 onEvent 回调相同的对象）。
  // 参见下方"事件类型"章节。

  // ── 性能指标 ────────────────────────────────────────────────────
  durationMs: number,
  // 总耗时（ms）

  cost: { totalUsd: number | null, numTurns: number | null },
  // 目前为 null（无法从 PTY 直接获取费用信息）。
  // 准确的令牌/费用数据请读取 JSONL 会话文件（见下文）。

  diagnostics: { rawBytes: number, strippedBytes: number },
  // 从 PTY 接收的原始字节数 / ANSI 去除后的字节数
}
```

### 事件类型（onEvent 回调）

`onEvent` 回调和 `result.events` 数组包含以下类型的事件：

```ts
// Claude 开始响应时（检测到 ⏺ 标记）
{ type: 'assistant-region-entered', n: number }

// 响应区域关闭时（检测到 hr 或 sentinel）
{ type: 'assistant-region-exited', n: number }

// 一行响应文本（实时流式传输）
{
  type: 'assistant-text',
  text: string,   // 一行文本（原始 markdown）
  region: number  // 第几个响应区域（编号越大越新，恢复时有用）
}

// 检测到 Claude 会话 UUID（来自 banner 或退出消息）
{ type: 'session-id', id: string }

// TUI 进度条（表示 Claude 正在工作）
// label: "Searching the web...", "Reading file...", "Cogitated for 25s" 等
{ type: 'spinner', label: string }

// TUI 输入框出现在屏幕上（完成信号之一）
{ type: 'prompt-box-shown' }

// 检测到 sentinel 字符串（正常完成）
{ type: 'sentinel' }
```

#### 事件使用示例

```js
const result = await driver.runOneShot({
  prompt: '分析这篇长文档',
  onEvent(ev) {
    switch (ev.type) {
      case 'assistant-text':
        // 实时流式传输——逐行打印
        process.stdout.write(ev.text + '\n');
        break;

      case 'spinner':
        // 进度条标签——工具使用中显示（如 "Searching the web..."）
        process.stderr.write(`\r⏳ ${ev.label}   `);
        break;

      case 'session-id':
        // 提前保存会话 ID，超时也能恢复
        saveSessionId(ev.id);
        break;
    }
  },
});
```

---

## 会话管理

Claude 用 UUID 标识每个会话，可用其恢复之前的对话。

```js
// 1. 第一次请求 — 开始新会话
const result1 = await driver.runOneShot({
  prompt: '用 Python 实现斐波那契数列',
});
console.log('会话 ID：', result1.sessionId);
// → "a1b2c3d4-5678-..."

// 2. 恢复会话 — 保留之前的对话上下文
const result2 = await driver.runOneShot({
  prompt: '现在用迭代而非递归改写',
  resume: result1.sessionId,
});

// 3. 分叉会话 — 保留原始会话，探索不同方向
const result3 = await driver.runOneShot({
  prompt: '改成生成器版本',
  resume: result1.sessionId,
  forkSession: true,   // 分配新 UUID，原始会话保留
});
```

---

## 使用 JSONL 会话文件

Claude CLI 将每个会话保存为 JSONL 文件：

```
~/.claude/projects/<cwd 编码路径>/<session-uuid>.jsonl
```

例如，`cwd` 为 `/Users/alice/myproject` 时：  
→ `~/.claude/projects/-Users-alice-myproject/<uuid>.jsonl`

这些文件包含 PTY 输出中不可用的**令牌用量、费用和工具使用元数据**。

```js
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function readSessionMeta(sessionId, cwd = process.cwd()) {
  const key = path.resolve(cwd).replace(/\//g, '-');
  const filePath = path.join(os.homedir(), '.claude', 'projects', key, `${sessionId}.jsonl`);
  const lines = (await readFile(filePath, 'utf8')).split('\n').filter(Boolean);

  // 从最后一条 assistant 消息中提取 usage
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (ev.message?.role === 'assistant') {
        const textBlock = ev.message.content?.find(c => c.type === 'text');
        return {
          text: textBlock?.text,     // 干净的 markdown 文本（无 TUI 残留）
          usage: ev.message.usage,   // { input_tokens, output_tokens, cache_read_input_tokens, ... }
          timestamp: ev.timestamp,
        };
      }
    } catch {}
  }
  return null;
}

const meta = await readSessionMeta(result.sessionId);
// meta.usage.input_tokens  → 输入令牌数
// meta.usage.output_tokens → 输出令牌数
// meta.usage.cache_read_input_tokens → 缓存读取令牌数
// meta.usage.server_tool_use.web_search_requests → 网络搜索次数
```

### JSONL 可获取的内容

| 项目 | PTY result.text | JSONL |
|------|----------------|-------|
| 响应文本 | ✅（可能含 TUI 残留） | ✅（干净 markdown） |
| 输入令牌数 | ❌ | ✅ |
| 输出令牌数 | ❌ | ✅ |
| 缓存令牌数 | ❌ | ✅ |
| 费用计算 | ❌ | ✅（令牌 × 单价） |
| 网络搜索次数 | ❌ | ✅ |
| 时间戳 | ❌ | ✅ |
| 工具使用详情 | 部分（事件） | ✅ |

---

## 关于输出解析

**`result.text` 是 Claude 生成的原始 markdown/文本。**  
这是开放格式——渲染、解析和显示方式由您自行实现。

```
result.text 示例：
─────────────────────────────────────
# 斐波那契数列

以下是用 Python 实现斐波那契数列的方法：

```python
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
```

- 时间复杂度：O(n)
- 空间复杂度：O(1)
─────────────────────────────────────
```

### 解析实现参考

`sample/public/app.js` 中的 `renderMarkdown()` 函数是 Web UI 的解析示例。  
请根据您的目标环境自行实现：

```js
// Web UI → HTML 渲染（示例）
import { marked } from 'marked';
const html = marked.parse(result.text);

// 终端 → ANSI 颜色渲染（示例）
import { renderMarkdown } from 'cli-markdown';
console.log(renderMarkdown(result.text));

// 传递给其他 LLM → 直接使用
const nextPrompt = `之前的响应：${result.text}\n\n现在继续下一步`;
```

### 关于 TUI 残留

`result.text` 已由 ocp 尽可能去除 TUI 渲染残留，但可能不完美。  
如需更干净的文本，建议从 **JSONL 会话文件**中读取（见上文）。

---

## 环境变量

### 常用

| 变量 | 说明 |
|------|------|
| `OCP_NO_AUTO_ACCEPT_TRUST=1` | 关闭 1.1 默认值（文件夹信任自动接受）。当你希望对话框出现时让调用 abort 时设置。 |
| `OCP_NO_SKIP_PERMS=1` | 关闭 1.1 CLI 默认值（`--dangerously-skip-permissions`）。会恢复 claude 的常规权限提示，但 PTY 自动化无法回答，所有工具调用都会 hang。 |
| `OCP_NO_SESSION_PERSISTENCE=1` | 禁用每轮的 JSONL 会话文件写入。适合每轮在服务端重建上下文的 stateless 集成。 |
| `OCP_NO_LIVE=1` | 禁用 stderr 上的实时 spinner |
| `OCP_NO_META=1` | 隐藏尾部 meta 行（`⏱ … · 🔧 …`） |
| `OCP_NO_DAEMON=1` | 每次调用都新建 PTY（不使用 warm 守护进程） |
| `OCP_DAEMON_IDLE_MS` | warm 守护进程在调用之间的存活时间。默认 `600000`（10 分钟）。 |
| `OCP_MAX_RESPONSE_MS` | 硬超时（毫秒），默认 `86400000`（24 小时） |
| `OCP_FIRST_RESPONSE_MS` | 发送 prompt 后 N ms 内无进展则 fail-fast，默认 `20000` |
| `OCP_PROMPT_BOX_WAIT_MS` | 等待输入 chevron(`❯`) 的最大时间，默认 `15000`（heavy hook/MCP 加载时调大） |
| `OCP_PASTE_MODE` | 大 prompt 的 TUI 写入方式：`auto`（默认，超过阈值时 chunked）、`chunk`（始终 chunk）、`bracket`（xterm bracketed paste 标记）、`raw`（1.1 之前的 atomic write） |
| `OCP_PASTE_THRESHOLD` | `auto` 模式触发 chunked write 的字节阈值。默认 `1024` |
| `OCP_DUMP_STALL=1` | 让 abort stderr 消息包含 PTY 屏幕 tail。默认不包含（tail 可能 echo 调用方的 prompt，安全 opt-in）。 |
| `OCP_CLAUDE_BIN` | upstream `claude` 二进制路径，默认 `'claude'` |

### 驱动器选项（库调用方）

| 变量 | 对应选项 | 默认值 |
|------|---------|--------|
| `OCP_CLAUDE_BIN` | `claudeBin` | `'claude'` |
| `OCP_WARMUP_MS` | `warmupMs` | `2500` |
| `OCP_REUSE_WARMUP_MS` | `reuseWarmupMs` | `200` |
| `OCP_IDLE_MS` | `idleMs` | `1500` |
| `OCP_PRE_IDLE_MS` | `preIdleMs` | `8000` |
| `OCP_POOL_SIZE` | `poolSize` | `0` |
| `OCP_POOL_MAX_AGE_MS` | `poolMaxAgeMs` | `600000` |

### 守护进程（仅 CLI）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OCP_NO_DAEMON` | 设为 `1` 时禁用守护进程，直接运行 PTY | — |
| `OCP_DAEMON_IDLE_MS` | 空闲此时间后自动终止守护进程 | `600000` |
| `OCP_MAX_DAEMONS` | 同时保持的最大守护进程数 | `30` |

```bash
# 将响应超时增加到 10 分钟
OCP_MAX_RESPONSE_MS=600000 ocp "复杂任务..."

# 不使用守护进程单次运行
OCP_NO_DAEMON=1 ocp "只运行一次"
```

---

## 完整选项参考

`runOneShot(req)` 请求字段与 CLI 标志的对应关系：

| req 字段 | CLI 标志 | 类型 | 说明 |
|---------|---------|------|------|
| `model` | `--model` | string | 模型名称（如 `sonnet`、`claude-sonnet-4-6`） |
| `systemPrompt` | `--system-prompt` | string | 替换整个系统提示 |
| `appendSystemPrompt` | `--append-system-prompt` | string | 追加到默认系统提示 |
| `dangerouslySkipPermissions` | `--dangerously-skip-permissions` | boolean | 跳过权限检查 |
| `allowedTools` | `--allowed-tools` | string[] | 工具白名单 |
| `disallowedTools` | `--disallowed-tools` | string[] | 工具黑名单 |
| `resume` | `--resume` / `-r` | string | 从会话 UUID 恢复 |
| `continue` | `--continue` / `-c` | boolean | 继续最近的会话 |
| `forkSession` | `--fork-session` | boolean | 恢复时创建新的会话 ID |
| `sessionId` | `--session-id` | string | 为新会话指定特定 UUID |
| `noSessionPersistence` | `--no-session-persistence` | boolean | 禁用会话保存 |
| `effort` | `--effort` | enum | `low` \| `medium` \| `high` \| `max` |
| `thinking` | `--thinking` | enum | `enabled` \| `adaptive` \| `disabled` |
| `maxTurns` | `--max-turns` | number | 最大代理轮次 |
| `fallbackModel` | `--fallback-model` | string | 主模型过载时的备用模型 |
| `permissionMode` | `--permission-mode` | string | `default` \| `plan` \| `acceptEdits` \| `bypassPermissions` |
| `mcpConfig` | `--mcp-config` | string[] | MCP 配置路径 |
| `addDir` | `--add-dir` | string[] | 工具可访问的附加目录 |
| `bare` | `--bare` | boolean | 最小模式（禁用 hooks、LSP、插件等） |
| `debug` | `--debug` | boolean | 将调试日志打印到 stderr |
| `verbose` | `--verbose` | boolean | 详细输出 |
| `cwd` | `--cwd` | string | PTY 进程工作目录 |
| `abortSignal` | — | AbortSignal | 取消信号 |
| `onEvent` | — | function | 实时事件回调 |
| `passThroughArgv` | — | string[] | 直接传递给 claude 的附加 argv |

---

## 示例应用

一个基于 `open-claude-p/chat` 构建的小型 Web 聊天 UI。源代码位于
upstream git repo 的 `sample/` 子目录中，但**不会打包进 npm tarball** —
而是包随附一个 `ocp-sample` 配套 CLI 按需下载示例。这样既保持已发布
install 体积小，又让示例只需一行就能试用。

### 快速开始

```bash
npm install -g open-claude-p          # 一次
ocp-sample init demo                   # 下载 + npm install
cd demo
ocp-sample start                       # → http://localhost:3000

# 完成后:
ocp-sample stop
```

### `init` 做了什么

1. 将 upstream repo 浅 clone 到临时目录。
2. 把 `sample/` 子树复制到 `./<name>/`（默认 `./ocp-sample/`）。
3. 重写复制后 `package.json` 的 dev 专用 `"open-claude-p": "file:.."` 依赖
   为真实的 semver 范围 — 基于此 CLI 自身版本 pin，保证 `ocp-sample`
   scaffold 的示例始终与同梱版本匹配。
4. 运行 `npm install --no-audit --no-fund`。
5. 尝试 `npm link open-claude-p` — 没有全局 link 时 silent no-op,
   有时用本地 dev 源代替 registry 副本。

### 子命令

| 命令 | 说明 |
|------|------|
| `ocp-sample init [name]` | 将示例下载并 install 到 `./<name>/`（默认 `ocp-sample`）。如果目录存在且非空则拒绝。 |
| `ocp-sample start [--port=N]` | 在 CWD 中以 detached 方式启动 `node server.js`。PID 写入 `.ocp-sample.pid`，stdout/stderr 追加到 `.ocp-sample.log`。也识别 `PORT` env。 |
| `ocp-sample stop` | 对运行中 PID 发送 SIGTERM（5 秒宽限后 SIGKILL）。 |
| `ocp-sample status` | 输出 `running` / `stopped` + PID + URL。 |

### cwd 中生成的文件

```
demo/
├── .ocp-sample.pid    运行中服务器的 PID（start 写入，stop 删除）
├── .ocp-sample.log    detached 服务器的 stdout/stderr（append）
├── server.js          Express + ocp/chat
├── package.json
├── public/            静态聊天 UI（index.html, app.js, style.css）
└── node_modules/      `npm install` 的结果
```

### 环境变量

| 变量 | 作用 |
|------|------|
| `PORT` | 覆盖 `start` 的默认端口(3000)。与 `--port=N` 等价。 |
| `NO_COLOR=1` | 禁用 ANSI 颜色和 spinner — 在 CI 和日志捕获中有用。 |
| `OCP_SAMPLE_NO_TTY=1` | 与 `NO_COLOR=1` 相同。 |
| `OCP_SAMPLE_REPO` | 覆盖 `init` 克隆的 upstream git URL。仅测试用。 |

### 示例展示的功能

示例刻意做得小，但实际涵盖了大多数 consumer 应用需要的 SDK 部分:

- **会话持久化** — `chat.send` + `~/.claude/projects/<cwd>/<sid>.jsonl`
- **SSE 流式输出** — `assistant-text` / `spinner` / `done` 事件传到浏览器
- **Skill 调用** — 在输入框输入 `/<skill-name>` 时注入 `~/.claude/skills/` 的 `SKILL.md`
- **进程管理** — 通过 `/api/processes` 列出和中止 in-flight 请求
- **Markdown 渲染** — 一个最简的客户端渲染器，处理聊天气泡中的 fenced code、标题、列表

`init` 之后查看 `demo/server.js` 可以看到完整 surface — 把那个文件
当作 "如何在 Express 应用中包装 `open-claude-p/chat`" 的标准参考实现。

---

## 模块结构

```
src/
  index.js                库公共 API（createDriver、runOneShot）
  options/
    spec.js               所有选项定义（单一来源）
    parse-argv.js         CLI argv 解析器
    validate.js           跨选项验证
  parsers/
    ansi-strip.js         ANSI 转义去除
    tui-frame.js          TUI 帧解析器（事件生成）
    sentinel.js           完成 sentinel 检测
    pipeline.js           解析器管道组合
  output/
    text.js               --output-format text 适配器
    json.js               --output-format json 适配器
    stream-json.js        --output-format stream-json 适配器
  pty/
    session.js            单个 PTY 会话生命周期
    pool.js               预热 PTY 池
  completion/
    detector.js           完成检测（sentinel + idle + prompt-box）
bin/
  cli.js                  ocp CLI 入口点
sample/
  server.js               示例 Web 服务器
  public/                 聊天 UI
```

---

## 许可证

MIT
