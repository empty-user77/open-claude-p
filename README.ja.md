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

**バージョン履歴**: [CHANGELOG.md](./CHANGELOG.md) を参照。

---

## 目次

- [インストール](#インストール)
- [推奨ワンタイム設定](#推奨ワンタイム設定)
- [`claude -p` との既知の差分](#claude--p-との既知の差分)
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

## 推奨ワンタイム設定

**1.1+ では不要です。** CLI のデフォルトは既に permissive：
フォルダ信頼ダイアログの自動承認 ON、`--dangerously-skip-permissions` ON。
`npm install -g open-claude-p` の後、そのまま `ocp "..."` が動きます。

claude の通常のパーミッションプロンプトを戻したい場合（PTY 自動化では
答えられないので全てのツール呼び出しが hang します）、opt-out 環境変数で
無効化：

```bash
export OCP_NO_AUTO_ACCEPT_TRUST=1   # "Do you trust this folder?" ダイアログで abort
export OCP_NO_SKIP_PERMS=1          # claude の通常パーミッションプロンプトを復元
```

> ⚠️ デフォルト CLI 設定では、`ocp "…"` 呼び出し 1 回でプロンプトの内容に
> 従って Bash、Write、Edit などのツールを確認なしで実行できます。個人の
> ワークステーションや、運用者がプロンプトを直接書く管理されたサービス
> アカウントには適切ですが、**信頼できない入力**（公開チャットボット、
> プロンプトインジェクションを受けやすい RAG など）がプロンプトに混ざる
> 環境では絶対にそのまま使わないでください。`--allowed-tools`、
> `OCP_NO_SKIP_PERMS=1`、または呼び出しごとの検証で表面を絞ってください。
>
> ライブラリのデフォルト（`createDriver` / `createChatClient`）は引き続き
> 保守的 — ライブラリ呼び出し元が明示的に権限スキップを opt-in します。

全環境変数一覧は [docs/cli-reference.md](./docs/cli-reference.md) 参照。

---

## `claude -p` との既知の差分

`ocp` は argv 互換の shim であり、`claude -p` とバイト単位で同一の出力を
保証するわけではありません。同じフラグでも以下のケースでは動作が異なるため、
コンシューマパイプラインに統合する際は事前に考慮してください：

- **`~/.claude.json` の状態に敏感.** PTY レイヤーは spawn ごとに完全な
  TUI バナーを描画するため、"1 MCP server needs auth · /mcp" や
  "auto mode unavailable"、プラグイン更新通知なども表示されます。
  `claude -p` はこういうのは描画しませんが、`ocp` は通り抜けるだけです
  （`⏺` か spinner イベントが見えるまで待機）。通知が多いと
  first-response latency が `OCP_FIRST_RESPONSE_MS`（デフォルト 20s）を
  超えて spurious な `interactive-required` abort が出ることがあります。
  env を増やすか、使わない MCP/プラグインを `~/.claude.json` から
  削除してください。

- **1KB 超のプロンプトは chunked write 経路.** 単一の多 KB write は claude
  の paste 検出を起動し、末尾の CR が paste content として消費されて
  プロンプトが永遠に送信されない回帰がありました。1.1+ では約 256 文字
  単位で短い delay 付き chunked write — 50–500 ms の追加 latency。
  以前の動作が必要なら `OCP_PASTE_MODE=raw`、TUI 入力ボックス自体を回避
  したいなら `--input-format=stream-json`。

- **セッション永続化はデフォルト ON.** 各ターンで `~/.claude/projects/<encoded-cwd>/`
  に JSONL セッションファイルを書きます。サーバ側で毎ターン会話履歴を
  再構築するステートレス統合では `OCP_NO_SESSION_PERSISTENCE=1`
  （または `--no-session-persistence`）で無効化してください。無効化しないと
  dead JSONL が溜まり `--continue` の探索が無関係な隣接ファイルを掴むことが
  あります。

- **デーモンは呼び出し元終了後も残る.** `~/.ocp/d-<hash>.sock` でデーモンが
  detach され、同じ cwd の次回呼び出しが 2.5s warmup をスキップ。
  `OCP_DAEMON_IDLE_MS`（デフォルト 10 分）で idle 時に自動終了。
  「子プロセスは親と一緒に死ぬべき」と期待するコンシューマアプリは
  `OCP_NO_DAEMON=1` か idle タイムアウトを短くしてください。

- **Print mode（`--print-mode` / `OCP_PRINT_MODE=1`）のみ PTY を完全に
  バイパス** し、実質 `claude --print` + argv pass-through。MCP サーバ、
  ツール権限プロンプト、その他あらゆるインタラクティブ surface は使えません
  — fallback や upstream parity テスト用途のみ。

- **Abort 時、出力アダプタは PTY ノイズを通さない.** completionReason が
  `timeout` / `interactive-required` / `trust-required` / `cancelled` /
  `write-failed` / `upstream-exited` のいずれかなら、`text`・`stream-json`
  アダプタは累積された PTY コンテンツをモデル応答として emit しません。
  `stream-json` は `result.subtype=error` + `completion=<reason>` のみを
  emit、短い stderr エラーメッセージに `detected: <kind>` のヒントを出力。
  `claude -p` は黙って失敗するか手元のテキストを echo していた部分とは
  異なります。

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

### よく使うもの

| 変数 | 説明 |
|------|------|
| `OCP_NO_AUTO_ACCEPT_TRUST=1` | 1.1 デフォルト（フォルダ信頼の自動承認）を無効化。ダイアログが出たら abort させたいとき。 |
| `OCP_NO_SKIP_PERMS=1` | 1.1 CLI デフォルト（`--dangerously-skip-permissions`）を無効化。claude の通常の権限プロンプトが復活しますが、PTY 自動化では答えられず全ツール呼び出しが hang します。 |
| `OCP_NO_SESSION_PERSISTENCE=1` | ターンごとの JSONL セッションファイル書き込みを無効化。毎ターンサーバ側で履歴を再構築するステートレス統合用。 |
| `OCP_NO_LIVE=1` | stderr のライブスピナーを無効化 |
| `OCP_NO_META=1` | 末尾の meta フッター（`⏱ … · 🔧 …`）を非表示 |
| `OCP_NO_DAEMON=1` | 毎回新しい PTY（warm デーモンを使わない） |
| `OCP_DAEMON_IDLE_MS` | warm デーモンが呼び出しの間に生き残る時間。デフォルト `600000`（10 分）。 |
| `OCP_MAX_RESPONSE_MS` | ハードタイムアウト、デフォルト `86400000`（24 時間） |
| `OCP_FIRST_RESPONSE_MS` | プロンプト送信後 N ms 以内に進展がなければ fail-fast、デフォルト `20000` |
| `OCP_PROMPT_BOX_WAIT_MS` | 入力 chevron(`❯`) の出現を待つ最大時間、デフォルト `15000`（heavy hook/MCP ロード時は増やす） |
| `OCP_PASTE_MODE` | 大きいプロンプトを TUI に送る方法：`auto`（デフォルト、しきい値超で chunked）、`chunk`（常に chunk）、`bracket`（xterm bracketed paste マーカー）、`raw`（1.1 以前の atomic write） |
| `OCP_PASTE_THRESHOLD` | `auto` モードでの chunked write 発動バイト数しきい値。デフォルト `1024` |
| `OCP_DUMP_STALL=1` | abort stderr メッセージに PTY 画面 tail を含める。デフォルトでは含めません（呼び出し側プロンプトが echo される可能性のため opt-in）。 |
| `OCP_CLAUDE_BIN` | upstream `claude` バイナリのパス、デフォルト `'claude'` |

### ドライバーオプション（ライブラリ呼び出し元向け）

| 変数 | 対応オプション | デフォルト |
|------|-------------|-----------|
| `OCP_CLAUDE_BIN` | `claudeBin` | `'claude'` |
| `OCP_WARMUP_MS` | `warmupMs` | `2500` |
| `OCP_REUSE_WARMUP_MS` | `reuseWarmupMs` | `200` |
| `OCP_IDLE_MS` | `idleMs` | `1500` |
| `OCP_PRE_IDLE_MS` | `preIdleMs` | `8000` |
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

`open-claude-p/chat` を使った小さな Web チャット UI です。ソースは
upstream の git repo の `sample/` 配下にあり、**npm tarball には
バンドルされません** — 代わりにパッケージが `ocp-sample` というコンパニオン
CLI を一緒に配布し、必要なときにオンデマンドでダウンロードします。これにより
publish された install を軽量に保ちつつ、デモは 1 行で試せます。

### クイックスタート

```bash
npm install -g open-claude-p          # 1 回だけ
ocp-sample init demo                   # ダウンロード + npm install
cd demo
ocp-sample start                       # → http://localhost:3000

# 終わったら:
ocp-sample stop
```

### `init` の動作

1. upstream repo を一時ディレクトリに shallow-clone。
2. `sample/` サブツリーを `./<name>/`（デフォルト `./ocp-sample/`）にコピー。
3. コピーされた `package.json` の dev 用 `"open-claude-p": "file:.."` dep
   を実際の semver 範囲に書き換え — この CLI 自身のバージョンに pin する
   ので `ocp-sample` が scaffold したデモは常に同梱バージョンと一致します。
4. `npm install --no-audit --no-fund` を実行。
5. `npm link open-claude-p` を試行 — グローバル link が無ければ silent
   no-op、ある場合は registry のコピー代わりにローカル dev ソースを link
   で使います。

### サブコマンド

| コマンド | 説明 |
|----------|------|
| `ocp-sample init [name]` | `./<name>/`（デフォルト `ocp-sample`）にデモをダウンロード + install。ディレクトリが存在して空でない場合は拒否。 |
| `ocp-sample start [--port=N]` | CWD から `node server.js` を detached で起動。PID を `.ocp-sample.pid` に、stdout/stderr を `.ocp-sample.log` に append。`PORT` env でも指定可。 |
| `ocp-sample stop` | 実行中の PID に SIGTERM（5 秒猶予の後 SIGKILL）。 |
| `ocp-sample status` | `running` / `stopped` + PID + URL を出力。 |

### cwd に作られるファイル

```
demo/
├── .ocp-sample.pid    実行中サーバの PID（start が書き込み、stop が削除）
├── .ocp-sample.log    detach されたサーバの stdout/stderr（append）
├── server.js          Express + ocp/chat
├── package.json
├── public/            静的チャット UI（index.html, app.js, style.css）
└── node_modules/      `npm install` の結果
```

### 環境変数

| 変数 | 効果 |
|------|------|
| `PORT` | `start` のデフォルトポート(3000)を変更。`--port=N` と同じ。 |
| `NO_COLOR=1` | ANSI 色とスピナーを無効化 — CI やログ取得に有用。 |
| `OCP_SAMPLE_NO_TTY=1` | `NO_COLOR=1` と同じ。 |
| `OCP_SAMPLE_REPO` | `init` が clone する upstream git URL を変更。テスト用。 |

### デモが見せる機能

デモは意図的に小さく作られていますが、ほとんどのコンシューマアプリが必要と
する SDK の部分を実際に通過させています：

- **会話の永続化** — `chat.send` + `~/.claude/projects/<cwd>/<sid>.jsonl`
- **SSE ストリーミング** — `assistant-text` / `spinner` / `done` をブラウザへ
- **スキル呼び出し** — `/<skill-name>` を打つと `~/.claude/skills/` の `SKILL.md` を注入
- **プロセス管理** — 進行中のリクエスト一覧・abort を `/api/processes` 経由で
- **Markdown レンダリング** — チャットバブルで fenced code、見出し、リストなどを処理する小さいクライアントサイドレンダラ

`init` 後の `demo/server.js` を見ると全 surface があります — 「Express
アプリに `open-claude-p/chat` をラップする方法」 の正式な参考実装として
扱ってください。

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
