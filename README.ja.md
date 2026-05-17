[English](README.md) · [한국어](README.ko.md) · [中文](README.zh.md) · **日本語**

[![npm](https://img.shields.io/npm/v/open-claude-p.svg)](https://www.npmjs.com/package/open-claude-p)
[![downloads](https://img.shields.io/npm/dm/open-claude-p.svg)](https://www.npmjs.com/package/open-claude-p)
[![stars](https://img.shields.io/github/stars/empty-user77/open-claude-p.svg)](https://github.com/empty-user77/open-claude-p/stargazers)
[![License](https://img.shields.io/npm/l/open-claude-p.svg)](https://github.com/empty-user77/open-claude-p/blob/main/LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ec1c8a?logo=github)](https://github.com/sponsors/empty-user77)

---

# open-claude-p (ocp)

`claude -p`（ヘッドレスプリントモード）が使用できない環境で、インタラクティブな `claude` CLI を **node-pty で直接駆動**し、同等の機能を提供する PTY ベースの互換レイヤーです。

> **核心的な違い**：`claude -p` は Claude Code の非対話モードで内部 API を通じて動作しますが、特定のプラン/環境では使用できません。`open-claude-p` は実際の TUI クライアントを PTY で実行し、出力ストリームを解析することで同じ結果を得ます。

---

## 目次

- [インストール](#インストール)
- [CLI の使い方](#cli-の使い方)
- [デーモン（セッション持続）](#デーモンセッション持続)
- [ライブラリ API](#ライブラリ-api)
  - [createDriver()](#createdriveropts)
  - [runOneShot()](#runoneshotreq)
  - [戻り値：OneShotResult](#戻り値oneshotresult)
  - [イベントタイプ（onEvent コールバック）](#イベントタイプonevent-コールバック)
- [セッション管理](#セッション管理)
- [JSONL セッションファイルの活用](#jsonl-セッションファイルの活用)
- [出力パースについて](#出力パースについて)
- [環境変数](#環境変数)
- [オプション全一覧](#オプション全一覧)
- [サンプルアプリ](#サンプルアプリ)

---

## インストール

### npm

```bash
# プロジェクト依存としてインストール
npm install open-claude-p

# またはどこからでも `ocp` CLI を使うためにグローバルインストール
npm install -g open-claude-p
```

### ソースからインストール（開発用）

```bash
# clone 後、プロジェクトルートでシンボリックリンクを作成
git clone https://github.com/empty-user77/open-claude-p.git
cd open-claude-p
npm link

# または他のプロジェクトからローカルパスでインストール
npm install /path/to/open-claude-p
```

**前提条件**：`claude` CLI が `PATH` にインストールされている必要があります。

```bash
# Claude Code CLI のインストール確認
claude --version
```

---

## CLI の使い方

このパッケージは単一バイナリ **`ocp`** をインストールします。

```bash
# 基本的な使い方
ocp "こんにちは"

# claude -p と同じ argv 形式をサポート（-p フラグは互換性のため無視）
ocp -p "こんにちは"

# stdin からプロンプトを読み込む
echo "東京の天気を教えて" | ocp

# 出力フォーマットを指定
ocp --output-format json "一言で答えて：りんご"
ocp --output-format stream-json "こんにちは"

# モデルを指定
ocp --model sonnet "複雑な質問..."
ocp --model claude-opus-4-7 "アーキテクチャレビュー..."

# システムプロンプトを追加
ocp --append-system-prompt "常に日本語で答えてください" "what's the weather?"

# セッションの再開 — sessionId は stderr に出力される
SID=$(ocp "キウイとだけ言って" 2>&1 >/dev/null | grep sessionId | grep -oE '[0-9a-f-]{36}')
ocp --resume "$SID" "さっき何て言ったの？"

# または最近のセッションを自動的に継続する
ocp --continue "さっき何て言ったの？"

# 権限チェックをスキップ（自動化環境向け）
ocp --dangerously-skip-permissions "ファイルを読んで分析して"
```

### 出力フォーマット

#### `text`（デフォルト）

```
こんにちは！何かお手伝いできますか？
```

#### `json`

```json
{
  "result": "こんにちは！何かお手伝いできますか？",
  "session_id": "a1b2c3d4-...",
  "is_error": false,
  "cost_usd": null,
  "duration_ms": 4200,
  "num_turns": 1
}
```

#### `stream-json`（NDJSON）

レスポンスが 1 行ずつストリーミングされます：

```jsonl
{"type":"system","subtype":"init","session_id":"a1b2c3d4-...","tools":[],"mcp_servers":[]}
{"type":"assistant","session_id":"a1b2c3d4-...","message":{"role":"assistant","content":[{"type":"text","text":"こんにちは！"}]}}
{"type":"result","subtype":"success","session_id":"a1b2c3d4-...","is_error":false,"duration_ms":4200}
```

---

## デーモン（セッション持続）

`ocp` CLI はデフォルトで**バックグラウンドデーモン**を通じて PTY セッションを維持します。  
同じディレクトリで繰り返し呼び出した際に 2.5 秒のウォームアップ待ちが不要になり、会話コンテキストが自動的に保持されます。

```
ocp "最初の質問"    → デーモンがなければ新規起動、あれば再利用
ocp "2番目の質問"   → 同じデーモンに接続、コンテキスト保持
```

デーモンソケットは `~/.ocp/` ディレクトリに**作業ディレクトリごとに**1 つ作成されます。

### デーモンの無効化

```bash
OCP_NO_DAEMON=1 ocp "一度だけ実行"   # デーモンなしで直接 PTY を実行
```

デーモンを使わない方が良い場合：
- `--resume`、`--continue`、`--fork-session` フラグを使用する場合（自動的に直接モードに切り替わります）
- `--input-format=stream-json` を使用する場合
- CI/CD など隔離された環境での単発実行の場合

### デーモン関連の環境変数

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `OCP_NO_DAEMON` | `1` に設定するとデーモンを無効化 | — |
| `OCP_DAEMON_IDLE_MS` | アイドル状態が続いた場合にデーモンを自動終了 | `600000`（10 分） |
| `OCP_MAX_DAEMONS` | 同時に維持する最大デーモン数 | `30` |

---

## ライブラリ API

### `createDriver(opts?)`

ドライバーを作成します。アプリケーション全体で単一のドライバーインスタンスを共有してください。

```js
import { createDriver } from 'open-claude-p';

const driver = createDriver({
  claudeBin:      'claude',     // claude バイナリのパス（デフォルト：PATH の claude）
  warmupMs:       2500,         // PTY 初期化待機時間（ms）
  reuseWarmupMs:  200,          // プールから再利用する際の待機時間（ms）
  idleMs:         1500,         // レスポンス完了後の無音待機（ms）
  preIdleMs:      8000,         // sentinel マッチング前の最小待機（ms）
  maxResponseMs:  60_000,       // 最大レスポンス待機時間（ms）、超過するとタイムアウト
  poolSize:       0,            // PTY プールサイズ（0=無効、N>0=N 個ウォームアップ維持）
  poolMaxAgeMs:   600_000,      // プールセッションの最大寿命（ms）
  cwd:            process.cwd(), // 作業ディレクトリ
  env:            {},           // 追加の環境変数
  debug:          false,        // デバッグログを stderr に出力
});
```

### `runOneShot(req)`

単一のプロンプトを Claude に送信し、レスポンスを待ちます。

```js
const result = await driver.runOneShot({
  prompt: '東京の現在の天気を教えてください',

  // ── モデル / 動作 ────────────────────────────
  model: 'sonnet',                        // モデル名
  effort: 'high',                         // 'low' | 'medium' | 'high' | 'max'
  thinking: 'adaptive',                   // 'enabled' | 'adaptive' | 'disabled'
  maxTurns: 5,                            // 最大エージェントターン数（shim 強制）

  // ── システムプロンプト ─────────────────────────
  systemPrompt: 'あなたは天気の専門家です',  // システムプロンプト全体を置換
  appendSystemPrompt: '常に日本語で',       // デフォルトプロンプトに追加

  // ── 権限 / ツール ─────────────────────────────
  dangerouslySkipPermissions: true,        // 権限チェックをスキップ
  allowedTools: ['WebSearch', 'Read'],     // ツールホワイトリスト
  disallowedTools: ['Bash'],               // ツールブラックリスト

  // ── セッション ────────────────────────────────
  resume: 'a1b2c3d4-...',                  // 前のセッション UUID から再開
  continue: false,                         // 最近のセッションを継続
  forkSession: false,                      // 再開時に新しいセッション ID を作成

  // ── 作業ディレクトリ ──────────────────────────
  cwd: '/path/to/project',

  // ── キャンセル ────────────────────────────────
  abortSignal: controller.signal,

  // ── リアルタイムイベントコールバック ──────────
  onEvent(ev) {
    // レスポンス生成中にリアルタイムで呼び出される
    // 下記「イベントタイプ」セクション参照
    if (ev.type === 'assistant-text') {
      process.stdout.write(ev.text);
    }
  },
});
```

### 戻り値：OneShotResult

`runOneShot()` が resolve されると、以下の構造のオブジェクトを返します：

```ts
{
  // ── コア結果 ────────────────────────────────────────────────────
  text: string,
  // Claude の最終レスポンステキスト（TUI アーティファクト除去済み）。
  // Claude が生成したままの生テキスト——markdown、HTML、コードブロックなど。
  // レンダリング/パースは呼び出し側の責任。

  sessionId: string | null,
  // このリクエストに対応する Claude セッション UUID。
  // --resume <sessionId> で会話を継続できる。
  // バナーキャプチャ失敗時は ~/.claude/projects/ のファイルシステムにフォールバック。

  isError: boolean,
  // true = エラーまたはタイムアウトで完了

  completionReason: string,
  // 完了理由：
  //   'sentinel'         正常完了（sentinel 文字列を検出）
  //   'idle'             レスポンス後の無音タイムアウト
  //   'prompt-box'       TUI 入力ボックスが再表示
  //   'timeout'          maxResponseMs を超過
  //   'max-turns'        maxTurns 制限に達した
  //   'upstream-exited'  claude プロセスが先に終了
  //   'write-failed'     PTY 書き込み失敗
  //   'cancelled'        AbortSignal でキャンセル

  exitCode: number,
  // 0 = 成功、1 = エラー

  // ── イベント配列 ────────────────────────────────────────────────
  events: Array<object>,
  // パイプラインが生成した全イベント（onEvent コールバックと同じオブジェクト）。
  // 下記「イベントタイプ」セクション参照。

  // ── パフォーマンスメトリクス ─────────────────────────────────────
  durationMs: number,
  // 総経過時間（ms）

  cost: { totalUsd: number | null, numTurns: number | null },
  // 現在は null（PTY からコスト情報を直接取得できないため）。
  // 正確なトークン/コストデータは JSONL セッションファイルから読み取ってください（下記参照）。

  diagnostics: { rawBytes: number, strippedBytes: number },
  // PTY から受信した生バイト数 / ANSI 除去後のバイト数
}
```

### イベントタイプ（onEvent コールバック）

`onEvent` コールバックと `result.events` 配列には以下のタイプのイベントが含まれます：

```ts
// Claude がレスポンスを開始したとき（⏺ マーカー検出）
{ type: 'assistant-region-entered', n: number }

// レスポンス領域が閉じたとき（hr または sentinel 検出）
{ type: 'assistant-region-exited', n: number }

// レスポンステキストの 1 行（リアルタイムストリーミング）
{
  type: 'assistant-text',
  text: string,   // 1 行のテキスト（生の markdown）
  region: number  // 何番目のレスポンス領域か（再開時に有用、番号が大きいほど新しい）
}

// Claude セッション UUID を検出（バナーまたは終了メッセージから）
{ type: 'session-id', id: string }

// TUI スピナー（Claude が処理中であることを示す）
// label: "Searching the web...", "Reading file...", "Cogitated for 25s" など
{ type: 'spinner', label: string }

// TUI 入力ボックスが画面に表示（完了シグナルの 1 つ）
{ type: 'prompt-box-shown' }

// sentinel 文字列を検出（正常完了）
{ type: 'sentinel' }
```

#### イベント活用例

```js
const result = await driver.runOneShot({
  prompt: '長いドキュメントを分析して',
  onEvent(ev) {
    switch (ev.type) {
      case 'assistant-text':
        // リアルタイムストリーミング——行ごとに出力
        process.stdout.write(ev.text + '\n');
        break;

      case 'spinner':
        // スピナーラベル——ツール使用中に表示（例："Searching the web..."）
        process.stderr.write(`\r⏳ ${ev.label}   `);
        break;

      case 'session-id':
        // セッション ID を早めに保存しておくとタイムアウト時も再開できる
        saveSessionId(ev.id);
        break;
    }
  },
});
```

---

## セッション管理

Claude は各セッションを UUID で識別し、それを使って以前の会話を再開できます。

```js
// 1. 最初のリクエスト — 新しいセッションを開始
const result1 = await driver.runOneShot({
  prompt: 'Python でフィボナッチ数列を実装して',
});
console.log('セッション ID:', result1.sessionId);
// → "a1b2c3d4-5678-..."

// 2. セッションの再開 — 以前の会話コンテキストが保持される
const result2 = await driver.runOneShot({
  prompt: 'それを再帰ではなくイテレーションで書き直して',
  resume: result1.sessionId,
});

// 3. セッションのフォーク — 元のセッションを保持しながら別の方向を探る
const result3 = await driver.runOneShot({
  prompt: '代わりにジェネレータバージョンを作って',
  resume: result1.sessionId,
  forkSession: true,   // 新しい UUID を割り当て、元のセッションを保持
});
```

---

## JSONL セッションファイルの活用

Claude CLI は各セッションを以下のパスに JSONL ファイルとして保存します：

```
~/.claude/projects/<cwd をパスとしてエンコード>/<session-uuid>.jsonl
```

例：`cwd` が `/Users/alice/myproject` の場合：  
→ `~/.claude/projects/-Users-alice-myproject/<uuid>.jsonl`

これらのファイルには PTY 出力では得られない**トークン使用量、コスト、ツール使用メタデータ**が含まれています。

```js
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function readSessionMeta(sessionId, cwd = process.cwd()) {
  const key = path.resolve(cwd).replace(/\//g, '-');
  const filePath = path.join(os.homedir(), '.claude', 'projects', key, `${sessionId}.jsonl`);
  const lines = (await readFile(filePath, 'utf8')).split('\n').filter(Boolean);

  // 最後の assistant メッセージから usage を抽出
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (ev.message?.role === 'assistant') {
        const textBlock = ev.message.content?.find(c => c.type === 'text');
        return {
          text: textBlock?.text,     // クリーンな markdown テキスト（TUI アーティファクトなし）
          usage: ev.message.usage,   // { input_tokens, output_tokens, cache_read_input_tokens, ... }
          timestamp: ev.timestamp,
        };
      }
    } catch {}
  }
  return null;
}

const meta = await readSessionMeta(result.sessionId);
// meta.usage.input_tokens  → 入力トークン数
// meta.usage.output_tokens → 出力トークン数
// meta.usage.cache_read_input_tokens → キャッシュ読み取りトークン数
// meta.usage.server_tool_use.web_search_requests → Web 検索回数
```

### JSONL から取得できるもの

| 項目 | PTY result.text | JSONL |
|------|----------------|-------|
| レスポンステキスト | ✅（TUI アーティファクトが含まれる可能性あり） | ✅（クリーンな markdown） |
| 入力トークン数 | ❌ | ✅ |
| 出力トークン数 | ❌ | ✅ |
| キャッシュトークン数 | ❌ | ✅ |
| コスト計算 | ❌ | ✅（トークン × 単価） |
| Web 検索回数 | ❌ | ✅ |
| タイムスタンプ | ❌ | ✅ |
| ツール使用詳細 | 部分的（イベント） | ✅ |

---

## 出力パースについて

**`result.text` は Claude が生成した生の markdown/テキストです。**  
オープンフォーマットなので、レンダリング、パース、表示方法は各プロジェクトで自分で実装してください。

```
result.text の例：
─────────────────────────────────────
# フィボナッチ数列

Python でフィボナッチ数列を実装する方法です：

```python
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
```

- 時間計算量：O(n)
- 空間計算量：O(1)
─────────────────────────────────────
```

### パース実装の参考

`sample/public/app.js` の `renderMarkdown()` 関数は Web UI 向けのパース例です。  
ターゲット環境に合わせて自分で実装してください：

```js
// Web UI → HTML レンダリング（例）
import { marked } from 'marked';
const html = marked.parse(result.text);

// ターミナル → ANSI カラーレンダリング（例）
import { renderMarkdown } from 'cli-markdown';
console.log(renderMarkdown(result.text));

// 別の LLM に渡す → そのまま使用
const nextPrompt = `前の回答：${result.text}\n\n次のステップに進んでください`;
```

### TUI アーティファクトについて

`result.text` は ocp が可能な限り TUI レンダリングの残留物を除去していますが、完璧ではない場合があります。  
よりクリーンなテキストが必要な場合は、**JSONL セッションファイル**から読み取ることを推奨します（上記参照）。

---

## 環境変数

### ドライバーオプション

| 変数 | 対応オプション | デフォルト |
|------|-------------|-----------|
| `OCP_CLAUDE_BIN` | `claudeBin` | `'claude'` |
| `OCP_WARMUP_MS` | `warmupMs` | `2500` |
| `OCP_REUSE_WARMUP_MS` | `reuseWarmupMs` | `200` |
| `OCP_IDLE_MS` | `idleMs` | `1500` |
| `OCP_PRE_IDLE_MS` | `preIdleMs` | `8000` |
| `OCP_MAX_RESPONSE_MS` | `maxResponseMs` | `60000` |
| `OCP_POOL_SIZE` | `poolSize` | `0` |
| `OCP_POOL_MAX_AGE_MS` | `poolMaxAgeMs` | `600000` |

### デーモン（CLI のみ）

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `OCP_NO_DAEMON` | `1` に設定するとデーモンを無効化し、PTY を直接実行 | — |
| `OCP_DAEMON_IDLE_MS` | アイドル状態が続いた場合にデーモンを自動終了 | `600000` |
| `OCP_MAX_DAEMONS` | 同時に維持する最大デーモン数 | `30` |

```bash
# レスポンスタイムアウトを 10 分に増やす
OCP_MAX_RESPONSE_MS=600000 ocp "複雑なタスク..."

# デーモンなしで単発実行
OCP_NO_DAEMON=1 ocp "一度だけ実行"
```

---

## オプション全一覧

`runOneShot(req)` リクエストフィールドと CLI フラグの対応表：

| req フィールド | CLI フラグ | 型 | 説明 |
|-------------|---------|---|------|
| `model` | `--model` | string | モデル名（例：`sonnet`、`claude-sonnet-4-6`） |
| `systemPrompt` | `--system-prompt` | string | システムプロンプト全体を置換 |
| `appendSystemPrompt` | `--append-system-prompt` | string | デフォルトシステムプロンプトに追加 |
| `dangerouslySkipPermissions` | `--dangerously-skip-permissions` | boolean | 権限チェックをスキップ |
| `allowedTools` | `--allowed-tools` | string[] | ツールホワイトリスト |
| `disallowedTools` | `--disallowed-tools` | string[] | ツールブラックリスト |
| `resume` | `--resume` / `-r` | string | セッション UUID から再開 |
| `continue` | `--continue` / `-c` | boolean | 最近のセッションを継続 |
| `forkSession` | `--fork-session` | boolean | 再開時に新しいセッション ID を作成 |
| `sessionId` | `--session-id` | string | 新しいセッションに特定の UUID を指定 |
| `noSessionPersistence` | `--no-session-persistence` | boolean | セッション保存を無効化 |
| `effort` | `--effort` | enum | `low` \| `medium` \| `high` \| `max` |
| `thinking` | `--thinking` | enum | `enabled` \| `adaptive` \| `disabled` |
| `maxTurns` | `--max-turns` | number | 最大エージェントターン数 |
| `fallbackModel` | `--fallback-model` | string | プライマリモデル過負荷時のフォールバック |
| `permissionMode` | `--permission-mode` | string | `default` \| `plan` \| `acceptEdits` \| `bypassPermissions` |
| `mcpConfig` | `--mcp-config` | string[] | MCP 設定パス |
| `addDir` | `--add-dir` | string[] | ツールがアクセスできる追加ディレクトリ |
| `bare` | `--bare` | boolean | 最小モード（hooks、LSP、プラグインなどを無効化） |
| `debug` | `--debug` | boolean | デバッグログを stderr に出力 |
| `verbose` | `--verbose` | boolean | 詳細出力 |
| `cwd` | `--cwd` | string | PTY プロセスの作業ディレクトリ |
| `abortSignal` | — | AbortSignal | キャンセルシグナル |
| `onEvent` | — | function | リアルタイムイベントコールバック |
| `passThroughArgv` | — | string[] | claude にそのまま渡す追加 argv |

---

## サンプルアプリ

`sample/` ディレクトリには ocp を使って構築した Web ベースのチャット UI が含まれています。

### 実行

```bash
cd sample
node server.js
# → http://localhost:3000
```

### サンプルアプリの構造

```
sample/
  server.js        Express サーバー — ocp ドライバーをラップ、SSE ストリーミング
  data/
    conversations.json  会話履歴（自動生成）
  public/
    index.html     チャット UI
    app.js         クライアントサイド JavaScript
    style.css      スタイルシート
```

### サンプルサーバー API

| エンドポイント | メソッド | 説明 |
|------------|--------|------|
| `/api/conversations` | GET | 会話一覧 |
| `/api/conversations/:id` | GET | 会話詳細（全メッセージ） |
| `/api/conversations/:id` | DELETE | 会話を削除 |
| `/api/chat` | POST | メッセージ送信（SSE ストリーミング） |
| `/api/monitor` | GET | PTY イベントモニター（SSE） |
| `/api/skills` | GET | `~/.claude/skills/` のスキル一覧 |
| `/api/processes` | GET | 進行中のリクエスト一覧（`id`、`prompt`、`elapsedMs`） |
| `/api/processes/:id` | DELETE | 特定のリクエストを中断（`all` で全て中断） |

### `/api/chat` SSE イベント

チャットリクエスト（`POST /api/chat`）は Server-Sent Events でレスポンスをストリーミングします：

```js
// クライアントリクエスト
const resp = await fetch('/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: '東京の天気を教えて',
    conversationId: null,    // null で新しい会話を開始
    skillName: 'my-skill',   // オプション：~/.claude/skills/ のスキル名
  }),
});

// SSE イベントの種類
{ type: 'spinner', label: 'Searching the web...' }  // 処理中の状態
{ type: 'text', text: 'こんにちは...' }              // ストリーミングテキスト（チャンク）
{ type: 'error', error: 'エラーメッセージ' }          // エラー
{
  type: 'done',
  conversationId: 'uuid',   // 会話 ID（保存済み）
  text: '完全な最終レスポンス',  // 完全な最終テキスト（JSONL からのクリーンな markdown）
  isNew: true,              // 新しい会話かどうか
  meta: {
    elapsedMs: 4200,        // 経過時間（ms）
    inputTokens: 1500,      // 入力トークン（キャッシュ含む）
    outputTokens: 320,      // 出力トークン
    costUsd: 0.0042,        // コスト（USD）
    tools: ['WebSearch'],   // 使用したツール
  }
}
```

### サンプルの Markdown パース

サンプルアプリ（`sample/public/app.js`）は `renderMarkdown()` 関数を通じて `result.text` を HTML に変換します。

**このパースコードはサンプル専用です。** 実際のプロジェクトでは：
- Web：`marked`、`markdown-it` など
- ターミナル：`cli-markdown`、`terminal-link` など
- React：`react-markdown`
- LLM 入力：そのまま使用

### プロセスマネージャー（`ocp-ps`）

サンプルアプリには `/api/processes` API を使って進行中のリクエストを一覧表示・キャンセルできる CLI ツールが含まれています。

```bash
cd sample

node ocp-ps.js              # 進行中のリクエスト一覧
node ocp-ps.js kill <id>    # 特定のリクエストを中断
node ocp-ps.js kill all     # 全て中断
node ocp-ps.js watch        # 1 秒ごとに自動更新
```

> **注意**：`ocp-ps` はサンプルアプリの HTTP API（`/api/processes`）を使うサンプル実装です。  
> ocp ライブラリを使って独自のサーバーを構築する際は、同じパターンでプロセス管理 API を実装できます。

### スキル呼び出し（`/スキル名`）

チャット入力欄で `/` を入力すると `~/.claude/skills/` のスキルがドロップダウンで表示されます。

```
ユーザー入力：/my-skill この PRD を分析して関連リポジトリを見つけて
             ↓
サーバー：SKILL.md の内容を appendSystemPrompt として注入
             ↓
Claude：スキルの指示に従って実行
```

---

## モジュール構造

```
src/
  index.js                ライブラリ公開 API（createDriver、runOneShot）
  options/
    spec.js               全オプション定義（単一ソース）
    parse-argv.js         CLI argv パーサー
    validate.js           クロスオプション検証
  parsers/
    ansi-strip.js         ANSI エスケープ除去
    tui-frame.js          TUI フレームパーサー（イベント生成）
    sentinel.js           完了 sentinel 検出
    pipeline.js           パーサーパイプライン合成
  output/
    text.js               --output-format text アダプター
    json.js               --output-format json アダプター
    stream-json.js        --output-format stream-json アダプター
  pty/
    session.js            単一 PTY セッションのライフサイクル
    pool.js               ウォームアップ済み PTY プール
  completion/
    detector.js           完了検出（sentinel + idle + prompt-box）
bin/
  cli.js                  ocp CLI エントリーポイント
sample/
  server.js               サンプル Web サーバー
  public/                 チャット UI
```

---

## ライセンス

MIT
