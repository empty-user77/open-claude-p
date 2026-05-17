[English](README.md) · **한국어** · [中文](README.zh.md) · [日本語](README.ja.md)

[![npm](https://img.shields.io/npm/v/open-claude-p.svg)](https://www.npmjs.com/package/open-claude-p)
[![downloads](https://img.shields.io/npm/dm/open-claude-p.svg)](https://www.npmjs.com/package/open-claude-p)
[![stars](https://img.shields.io/github/stars/empty-user77/open-claude-p.svg)](https://github.com/empty-user77/open-claude-p/stargazers)
[![License](https://img.shields.io/npm/l/open-claude-p.svg)](https://github.com/empty-user77/open-claude-p/blob/main/LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ec1c8a?logo=github)](https://github.com/sponsors/empty-user77)

---

# open-claude-p (ocp)

`claude -p`(헤드리스 프린트 모드)를 사용할 수 없는 환경에서, 인터랙티브 `claude` CLI를 **node-pty로 직접 구동**하여 동일한 기능을 제공하는 PTY 기반 호환 레이어입니다.

> **핵심 차이**: `claude -p`는 Claude Code의 비대화형 모드로 내부 API를 통해 동작하지만, 특정 플랜/환경에서는 사용할 수 없습니다. `open-claude-p`는 실제 TUI 클라이언트를 PTY로 실행하고 출력 스트림을 파싱하여 동일한 결과를 얻습니다.

---

## 목차

- [설치](#설치)
- [CLI 사용법](#cli-사용법)
- [데몬 (세션 유지)](#데몬-세션-유지)
- [라이브러리 API](#라이브러리-api)
  - [createDriver()](#createdriveropts)
  - [runOneShot()](#runoneshotreq)
  - [반환값: OneShotResult](#반환값-oneshotresult)
  - [이벤트 타입 (onEvent 콜백)](#이벤트-타입-onevent-콜백)
- [세션 관리](#세션-관리)
- [JSONL 세션 파일 활용](#jsonl-세션-파일-활용)
- [출력 파싱에 대하여](#출력-파싱에-대하여)
- [환경변수](#환경변수)
- [옵션 전체 목록](#옵션-전체-목록)
- [샘플 앱 사용법](#샘플-앱-사용법)

---

## 설치

### npm

```bash
# 프로젝트 의존성으로 설치
npm install open-claude-p

# 또는 어디서든 `ocp` CLI를 쓰려면 전역 설치
npm install -g open-claude-p
```

### 소스 빌드 (개발용)

```bash
# 저장소를 clone 후 프로젝트 루트에서 symlink 설치
git clone https://github.com/empty-user77/open-claude-p.git
cd open-claude-p
npm link

# 또는 다른 프로젝트에서 로컬 경로로 설치
npm install /path/to/open-claude-p
```

**전제 조건**: `claude` CLI가 `PATH`에 설치되어 있어야 합니다.

```bash
# Claude Code CLI 설치 확인
claude --version
```

---

## CLI 사용법

패키지는 단일 바이너리 **`ocp`** 를 설치합니다.

```bash
# 기본 사용
ocp "안녕하세요"

# claude -p 와 동일한 argv 형식 지원 (-p 플래그는 호환성을 위해 무시됨)
ocp -p "안녕하세요"

# stdin에서 프롬프트 읽기
echo "서울 날씨 알려줘" | ocp

# 출력 포맷 지정
ocp --output-format json "한 단어로 대답: 사과"
ocp --output-format stream-json "안녕"

# 모델 지정
ocp --model sonnet "복잡한 질문..."
ocp --model claude-opus-4-7 "설계 리뷰..."

# 시스템 프롬프트 추가
ocp --append-system-prompt "항상 한국어로 답변하세요" "what's the weather?"

# 세션 재개 — sessionId는 stderr에 출력됨
SID=$(ocp "키위라고만 대답해" 2>&1 >/dev/null | grep sessionId | grep -oE '[0-9a-f-]{36}')
ocp --resume "$SID" "방금 뭐라고 했어?"

# 또는 가장 최근 세션을 자동으로 이어받기
ocp --continue "방금 뭐라고 했어?"

# 권한 검사 건너뜀 (자동화 환경)
ocp --dangerously-skip-permissions "파일을 읽어서 분석해줘"
```

### 출력 포맷

#### `text` (기본값)

```
안녕하세요! 무엇을 도와드릴까요?
```

#### `json`

```json
{
  "result": "안녕하세요! 무엇을 도와드릴까요?",
  "session_id": "a1b2c3d4-...",
  "is_error": false,
  "cost_usd": null,
  "duration_ms": 4200,
  "num_turns": 1
}
```

#### `stream-json` (NDJSON)

응답이 한 줄씩 스트리밍됩니다:

```jsonl
{"type":"system","subtype":"init","session_id":"a1b2c3d4-...","tools":[],"mcp_servers":[]}
{"type":"assistant","session_id":"a1b2c3d4-...","message":{"role":"assistant","content":[{"type":"text","text":"안녕하세요!"}]}}
{"type":"result","subtype":"success","session_id":"a1b2c3d4-...","is_error":false,"duration_ms":4200}
```

---

## 데몬 (세션 유지)

`ocp` CLI는 기본적으로 **백그라운드 데몬**을 통해 PTY를 살려두고 세션을 이어갑니다.  
같은 디렉토리에서 반복 호출 시 매번 2.5초 워밍업을 기다리지 않아도 되고, 대화 컨텍스트가 자동으로 유지됩니다.

```
ocp "첫 번째 질문"    → 데몬 없으면 새로 시작, 있으면 재사용
ocp "두 번째 질문"    → 같은 데몬에 연결, 컨텍스트 유지
```

데몬 소켓은 `~/.ocp/` 디렉토리에 **작업 디렉토리별로** 하나씩 생성됩니다.

### 데몬 비활성화

```bash
OCP_NO_DAEMON=1 ocp "한 번만 실행"   # 데몬 없이 직접 PTY 실행
```

데몬을 쓰지 않아야 하는 경우:
- `--resume`, `--continue`, `--fork-session` 플래그 사용 시 (자동으로 직접 모드 전환됨)
- `--input-format=stream-json` 사용 시
- CI/CD 등 격리된 환경에서 단건 실행 시

### 데몬 관련 환경변수

| 변수명 | 설명 | 기본값 |
|--------|------|--------|
| `OCP_NO_DAEMON` | `1`로 설정 시 데몬 비활성화 | — |
| `OCP_DAEMON_IDLE_MS` | 유휴 상태 지속 시 데몬 자동 종료 | `600000` (10분) |
| `OCP_MAX_DAEMONS` | 동시에 유지할 최대 데몬 수 | `30` |

---

## 라이브러리 API

### `createDriver(opts?)`

드라이버를 생성합니다. 드라이버는 애플리케이션 전체에서 공유해서 사용합니다.

```js
import { createDriver } from 'open-claude-p';

const driver = createDriver({
  claudeBin:      'claude',     // claude 바이너리 경로 (기본: PATH의 claude)
  warmupMs:       2500,         // PTY 초기화 대기 시간 (ms)
  reuseWarmupMs:  200,          // 풀에서 재사용 시 대기 시간 (ms)
  idleMs:         1500,         // 응답 완료 후 침묵 대기 (ms)
  preIdleMs:      8000,         // sentinel 매칭 전 최소 대기 (ms)
  maxResponseMs:  60_000,       // 최대 응답 대기 시간 (ms), 초과 시 timeout
  poolSize:       0,            // PTY 풀 크기 (0=비활성, N>0=N개 워밍업 유지)
  poolMaxAgeMs:   600_000,      // 풀 세션 최대 수명 (ms)
  cwd:            process.cwd(), // 작업 디렉토리
  env:            {},           // 추가 환경변수
  debug:          false,        // stderr에 디버그 로그 출력
});
```

### `runOneShot(req)`

단일 프롬프트를 Claude에게 전송하고 응답을 기다립니다.

```js
const result = await driver.runOneShot({
  prompt: '서울의 현재 날씨를 알려줘',

  // ── 모델 / 동작 ──────────────────────────
  model: 'sonnet',                        // 모델 지정
  effort: 'high',                         // 'low' | 'medium' | 'high' | 'max'
  thinking: 'adaptive',                   // 'enabled' | 'adaptive' | 'disabled'
  maxTurns: 5,                            // 최대 에이전트 턴 수 (shim 강제)

  // ── 시스템 프롬프트 ───────────────────────
  systemPrompt: '너는 날씨 전문가야',      // 시스템 프롬프트 전체 대체
  appendSystemPrompt: '항상 한국어로',     // 기본 프롬프트에 추가

  // ── 권한 / 도구 ───────────────────────────
  dangerouslySkipPermissions: true,        // 권한 검사 건너뜀
  allowedTools: ['WebSearch', 'Read'],     // 허용 도구 화이트리스트
  disallowedTools: ['Bash'],               // 차단 도구 블랙리스트

  // ── 세션 ──────────────────────────────────
  resume: 'a1b2c3d4-...',                  // 이전 세션 UUID로 재개
  continue: false,                         // 가장 최근 세션 계속
  forkSession: false,                      // resume 시 새 세션 ID 생성

  // ── 작업 디렉토리 ─────────────────────────
  cwd: '/path/to/project',

  // ── 취소 ──────────────────────────────────
  abortSignal: controller.signal,

  // ── 실시간 이벤트 콜백 ────────────────────
  onEvent(ev) {
    // 응답이 생성되는 동안 실시간으로 호출됨
    // 이벤트 타입은 아래 "이벤트 타입" 섹션 참고
    if (ev.type === 'assistant-text') {
      process.stdout.write(ev.text);
    }
  },
});
```

### 반환값: OneShotResult

`runOneShot()`이 resolve되면 다음 구조의 객체를 반환합니다:

```ts
{
  // ── 핵심 결과 ──────────────────────────────────────────────────────
  text: string,
  // Claude의 최종 응답 텍스트 (TUI 아티팩트 제거됨).
  // 마크다운, HTML, 코드블록 등 Claude가 생성한 원본 텍스트.
  // 렌더링/파싱은 호출하는 쪽에서 직접 해야 함.

  sessionId: string | null,
  // 이 요청에 해당하는 Claude 세션 UUID.
  // --resume <sessionId> 로 대화를 이어갈 수 있음.
  // 배너 캡처 실패 시 ~/.claude/projects/ 파일시스템으로 폴백.

  isError: boolean,
  // true = 오류 또는 timeout으로 완료

  completionReason: string,
  // 완료 이유:
  //   'sentinel'         정상 완료 (sentinel 문자열 감지)
  //   'idle'             응답 후 침묵 타임아웃
  //   'prompt-box'       TUI 입력 박스 재등장 감지
  //   'timeout'          maxResponseMs 초과
  //   'max-turns'        maxTurns 한도 도달
  //   'upstream-exited'  claude 프로세스가 먼저 종료
  //   'write-failed'     PTY write 실패
  //   'cancelled'        AbortSignal로 취소됨

  exitCode: number,
  // 0 = 정상, 1 = 오류

  // ── 이벤트 배열 ────────────────────────────────────────────────────
  events: Array<object>,
  // 파이프라인이 생성한 이벤트 전체 배열 (onEvent 콜백과 동일한 객체들).
  // 아래 "이벤트 타입" 섹션 참고.

  // ── 성능 메트릭 ────────────────────────────────────────────────────
  durationMs: number,
  // 총 소요 시간 (ms)

  cost: { totalUsd: number | null, numTurns: number | null },
  // 현재 null (PTY에서는 비용 정보를 직접 획득할 수 없음).
  // 정확한 토큰/비용 정보는 JSONL 세션 파일에서 읽어야 함 (아래 참고).

  diagnostics: { rawBytes: number, strippedBytes: number },
  // PTY에서 받은 원시 바이트 수 / ANSI 제거 후 바이트 수
}
```

### 이벤트 타입 (onEvent 콜백)

`onEvent` 콜백과 `result.events` 배열에는 다음 타입의 이벤트가 포함됩니다:

```ts
// Claude가 응답을 시작했을 때 (⏺ 마커 감지)
{ type: 'assistant-region-entered', n: number }

// 응답 영역이 닫혔을 때 (hr 또는 sentinel 감지)
{ type: 'assistant-region-exited', n: number }

// 응답 텍스트 한 줄 (실시간 스트리밍)
{
  type: 'assistant-text',
  text: string,   // 한 줄의 텍스트 (마크다운 원문 그대로)
  region: number  // 몇 번째 응답 영역인지 (resume 시 이전 기록이 높은 번호로 필터됨)
}

// Claude 세션 UUID 감지 (배너 또는 exit 메시지에서)
{ type: 'session-id', id: string }

// TUI 스피너 (작업 중 상태 표시)
// label: "Searching the web...", "Reading file...", "Cogitated for 25s" 등
{ type: 'spinner', label: string }

// TUI 입력 박스가 화면에 나타남 (완료 신호 중 하나)
{ type: 'prompt-box-shown' }

// sentinel 문자열이 감지됨 (정상 완료)
{ type: 'sentinel' }
```

#### 이벤트 활용 예시

```js
const result = await driver.runOneShot({
  prompt: '긴 문서를 분석해줘',
  onEvent(ev) {
    switch (ev.type) {
      case 'assistant-text':
        // 실시간 스트리밍 — 줄 단위로 화면에 출력
        process.stdout.write(ev.text + '\n');
        break;

      case 'spinner':
        // 스피너 라벨 — 도구 사용 중 표시 (예: "Searching the web...")
        process.stderr.write(`\r⏳ ${ev.label}   `);
        break;

      case 'session-id':
        // 세션 ID를 미리 저장해두면 timeout 시에도 재개 가능
        saveSessionId(ev.id);
        break;
    }
  },
});

// 전체 텍스트는 events에서도 재조합 가능
const lines = result.events
  .filter(e => e.type === 'assistant-text' && e.region === Math.max(...result.events.filter(e => e.type === 'assistant-text').map(e => e.region)))
  .map(e => e.text);
```

---

## 세션 관리

Claude는 각 세션을 UUID로 구분하고, 세션 ID를 이용해 이전 대화를 이어갈 수 있습니다.

```js
// 1. 첫 번째 요청 — 새 세션 시작
const result1 = await driver.runOneShot({
  prompt: '파이썬으로 피보나치를 구현해줘',
});
console.log('세션 ID:', result1.sessionId);
// → "a1b2c3d4-5678-..."

// 2. 세션 재개 — 이전 대화 컨텍스트가 유지됨
const result2 = await driver.runOneShot({
  prompt: '그 코드를 재귀가 아닌 반복으로 바꿔줘',
  resume: result1.sessionId,
});

// 3. 세션 분기 — 원본 보존하면서 다른 방향 탐색
const result3 = await driver.runOneShot({
  prompt: '대신 제너레이터 버전으로 만들어줘',
  resume: result1.sessionId,
  forkSession: true,   // 새 UUID 할당, 원본 세션 보존
});
```

---

## JSONL 세션 파일 활용

Claude CLI는 각 세션을 아래 경로에 JSONL 파일로 저장합니다:

```
~/.claude/projects/<cwd를-로-인코딩된-경로>/<session-uuid>.jsonl
```

예: cwd가 `/Users/alice/myproject`이면  
→ `~/.claude/projects/-Users-alice-myproject/<uuid>.jsonl`

이 파일에는 PTY 출력에는 없는 **토큰 사용량, 비용, 도구 사용 내역** 등의 메타데이터가 포함되어 있습니다.

```js
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function readSessionMeta(sessionId, cwd = process.cwd()) {
  const key = path.resolve(cwd).replace(/\//g, '-');
  const filePath = path.join(os.homedir(), '.claude', 'projects', key, `${sessionId}.jsonl`);
  const lines = (await readFile(filePath, 'utf8')).split('\n').filter(Boolean);

  // 마지막 assistant 메시지에서 usage 추출
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (ev.message?.role === 'assistant') {
        const textBlock = ev.message.content?.find(c => c.type === 'text');
        return {
          text: textBlock?.text,     // 클린 마크다운 텍스트 (TUI 아티팩트 없음)
          usage: ev.message.usage,   // { input_tokens, output_tokens, cache_read_input_tokens, ... }
          timestamp: ev.timestamp,
        };
      }
    } catch {}
  }
  return null;
}

const meta = await readSessionMeta(result.sessionId);
// meta.usage.input_tokens  → 입력 토큰
// meta.usage.output_tokens → 출력 토큰
// meta.usage.cache_read_input_tokens → 캐시 읽기 토큰
// meta.usage.server_tool_use.web_search_requests → 웹 검색 횟수
```

### JSONL에서 얻을 수 있는 것

| 항목 | PTY result.text | JSONL |
|------|----------------|-------|
| 응답 텍스트 | ✅ (TUI 아티팩트 포함 가능) | ✅ (클린 마크다운) |
| 입력 토큰 수 | ❌ | ✅ |
| 출력 토큰 수 | ❌ | ✅ |
| 캐시 토큰 수 | ❌ | ✅ |
| 비용 계산 | ❌ | ✅ (토큰 × 단가) |
| 웹 검색 횟수 | ❌ | ✅ |
| 타임스탬프 | ❌ | ✅ |
| 도구 사용 내역 | 부분적 (이벤트) | ✅ |

---

## 출력 파싱에 대하여

**`result.text`는 Claude가 생성한 원시 마크다운/텍스트입니다.**  
오픈 포맷이라 렌더링, 파싱, 표시 방법은 각 프로젝트에서 직접 구현해야 합니다.

```
result.text 예시:
─────────────────────────────────────
# 피보나치 수열

파이썬으로 피보나치를 구현하는 방법입니다:

```python
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
```

- 시간 복잡도: O(n)
- 공간 복잡도: O(1)
─────────────────────────────────────
```

### 파싱 구현 참고

`sample/public/app.js`의 `renderMarkdown()` 함수는 웹 UI를 위한 파싱 예시입니다.  
실제 사용 환경에 맞게 직접 구현하세요:

```js
// 웹 UI → HTML 렌더링 (예시)
import { marked } from 'marked';
const html = marked.parse(result.text);

// 터미널 → ANSI 컬러 렌더링 (예시)
import { renderMarkdown } from 'cli-markdown';
console.log(renderMarkdown(result.text));

// 다른 LLM에 전달 → 그대로 사용
const nextPrompt = `이전 응답: ${result.text}\n\n이제 다음 단계를 진행해줘`;
```

### TUI 아티팩트에 대하여

`result.text`는 ocp가 최대한 TUI 렌더링 잔재를 제거하지만, 완벽하지 않을 수 있습니다.  
더 클린한 텍스트가 필요하면 **JSONL 세션 파일**에서 읽는 것을 권장합니다 (위 참고).

---

## 환경변수

### 드라이버 옵션

| 변수명 | 대응 옵션 | 기본값 |
|--------|-----------|--------|
| `OCP_CLAUDE_BIN` | `claudeBin` | `'claude'` |
| `OCP_WARMUP_MS` | `warmupMs` | `2500` |
| `OCP_REUSE_WARMUP_MS` | `reuseWarmupMs` | `200` |
| `OCP_IDLE_MS` | `idleMs` | `1500` |
| `OCP_PRE_IDLE_MS` | `preIdleMs` | `8000` |
| `OCP_MAX_RESPONSE_MS` | `maxResponseMs` | `60000` |
| `OCP_POOL_SIZE` | `poolSize` | `0` |
| `OCP_POOL_MAX_AGE_MS` | `poolMaxAgeMs` | `600000` |

### 데몬 (CLI 전용)

| 변수명 | 설명 | 기본값 |
|--------|------|--------|
| `OCP_NO_DAEMON` | `1`로 설정 시 데몬 비활성화, 직접 PTY 실행 | — |
| `OCP_DAEMON_IDLE_MS` | 유휴 상태 지속 시 데몬 자동 종료 대기 시간 | `600000` |
| `OCP_MAX_DAEMONS` | 동시에 유지할 최대 데몬 수 | `30` |

```bash
# 응답 제한 시간을 10분으로 늘리기
OCP_MAX_RESPONSE_MS=600000 ocp "복잡한 작업..."

# 데몬 없이 단건 실행
OCP_NO_DAEMON=1 ocp "한 번만 실행"
```

---

## 옵션 전체 목록

`runOneShot(req)` 요청 객체와 CLI 플래그 대응표:

| req 필드 | CLI 플래그 | 타입 | 설명 |
|----------|-----------|------|------|
| `model` | `--model` | string | 모델 이름 (예: `sonnet`, `claude-sonnet-4-6`) |
| `systemPrompt` | `--system-prompt` | string | 시스템 프롬프트 전체 대체 |
| `appendSystemPrompt` | `--append-system-prompt` | string | 기본 시스템 프롬프트에 추가 |
| `dangerouslySkipPermissions` | `--dangerously-skip-permissions` | boolean | 권한 검사 건너뜀 |
| `allowedTools` | `--allowed-tools` | string[] | 허용 도구 화이트리스트 |
| `disallowedTools` | `--disallowed-tools` | string[] | 차단 도구 블랙리스트 |
| `resume` | `--resume` / `-r` | string | 세션 UUID로 재개 |
| `continue` | `--continue` / `-c` | boolean | 가장 최근 세션 계속 |
| `forkSession` | `--fork-session` | boolean | resume 시 새 세션 ID 생성 |
| `sessionId` | `--session-id` | string | 새 세션에 특정 UUID 지정 |
| `noSessionPersistence` | `--no-session-persistence` | boolean | 세션 저장 비활성화 |
| `effort` | `--effort` | enum | `low` \| `medium` \| `high` \| `max` |
| `thinking` | `--thinking` | enum | `enabled` \| `adaptive` \| `disabled` |
| `maxTurns` | `--max-turns` | number | 최대 에이전트 턴 수 |
| `fallbackModel` | `--fallback-model` | string | 기본 모델 과부하 시 폴백 |
| `permissionMode` | `--permission-mode` | string | `default` \| `plan` \| `acceptEdits` \| `bypassPermissions` |
| `mcpConfig` | `--mcp-config` | string[] | MCP 설정 경로 |
| `addDir` | `--add-dir` | string[] | 도구가 접근할 추가 디렉토리 |
| `bare` | `--bare` | boolean | 최소 모드 (hooks, LSP, 플러그인 등 비활성) |
| `debug` | `--debug` | boolean | 디버그 로그를 stderr에 출력 |
| `verbose` | `--verbose` | boolean | 상세 출력 |
| `cwd` | `--cwd` | string | PTY 프로세스 작업 디렉토리 |
| `abortSignal` | — | AbortSignal | 요청 취소 신호 |
| `onEvent` | — | function | 실시간 이벤트 콜백 |
| `passThroughArgv` | — | string[] | claude에 그대로 전달할 추가 argv |

---

## 샘플 앱 사용법

`sample/` 디렉토리에는 ocp를 활용한 웹 기반 채팅 UI가 포함되어 있습니다.

### 실행

```bash
cd sample
node server.js
# → http://localhost:3000
```

### 샘플 앱 구조

```
sample/
  server.js        Express 서버 — ocp 드라이버 래핑, SSE 스트리밍
  data/
    conversations.json  대화 기록 (자동 생성)
  public/
    index.html     채팅 UI
    app.js         클라이언트 JavaScript
    style.css      스타일시트
```

### 샘플 서버 API

| 엔드포인트 | 메서드 | 설명 |
|-----------|--------|------|
| `/api/conversations` | GET | 대화 목록 |
| `/api/conversations/:id` | GET | 대화 상세 (전체 메시지) |
| `/api/conversations/:id` | DELETE | 대화 삭제 |
| `/api/chat` | POST | 메시지 전송 (SSE 스트리밍) |
| `/api/monitor` | GET | PTY 이벤트 모니터 (SSE) |
| `/api/skills` | GET | `~/.claude/skills/` 스킬 목록 |
| `/api/processes` | GET | 진행 중인 요청 목록 (`id`, `prompt`, `elapsedMs`) |
| `/api/processes/:id` | DELETE | 특정 요청 abort (`all`로 전체 종료) |

### `/api/chat` SSE 이벤트

채팅 요청(`POST /api/chat`)은 Server-Sent Events로 응답을 스트리밍합니다:

```js
// 클라이언트 요청
const resp = await fetch('/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: '서울 날씨 알려줘',
    conversationId: null,    // null이면 새 대화 시작
    skillName: 'my-skill',       // 선택사항: ~/.claude/skills/ 의 스킬 이름
  }),
});

// SSE 이벤트 종류
{ type: 'spinner', label: 'Searching the web...' }  // 작업 중 상태
{ type: 'text', text: '안녕하세요...' }              // 스트리밍 텍스트 (조각)
{ type: 'error', error: '오류 메시지' }              // 오류
{
  type: 'done',
  conversationId: 'uuid',   // 대화 ID (저장됨)
  text: '최종 전체 응답',    // 완전한 최종 텍스트 (JSONL에서 읽은 클린 마크다운)
  isNew: true,              // 새 대화 여부
  meta: {
    elapsedMs: 4200,        // 소요 시간 (ms)
    inputTokens: 1500,      // 인풋 토큰 (cache 포함)
    outputTokens: 320,      // 아웃풋 토큰
    costUsd: 0.0042,        // 비용 (USD)
    tools: ['WebSearch'],   // 사용된 도구 목록
  }
}
```

### 샘플의 마크다운 파싱

샘플 앱(`sample/public/app.js`)은 `renderMarkdown()` 함수로 `result.text`를 HTML로 변환합니다.

**이 파싱 코드는 샘플 전용입니다.** 실제 프로젝트에서는:
- 웹: `marked`, `markdown-it` 등 라이브러리 사용
- 터미널: `cli-markdown`, `terminal-link` 등 사용
- React: `react-markdown` 사용
- 다른 LLM 입력: 그대로 사용

### 프로세스 매니저 (`ocp-ps`)

샘플 앱은 `/api/processes` API를 이용해 진행 중인 요청을 조회·취소할 수 있는 CLI 도구를 함께 제공합니다.

```bash
cd sample

node ocp-ps.js              # 실행 중인 요청 목록
node ocp-ps.js kill <id>    # 특정 요청 abort
node ocp-ps.js kill all     # 전체 abort
node ocp-ps.js watch        # 1초마다 자동 갱신
```

> **참고**: `ocp-ps`는 샘플 앱의 HTTP API(`/api/processes`)를 사용하는 샘플 구현체입니다.  
> ocp 라이브러리를 사용해 서버를 직접 구현할 때는 같은 패턴으로 프로세스 관리 API를 구성할 수 있습니다.

### 스킬 호출 (`/스킬명`)

채팅 입력창에서 `/`를 타이핑하면 `~/.claude/skills/` 의 스킬 목록이 드롭다운으로 표시됩니다.

```
사용자 입력: /my-skill 이 문서 분석해서 결과 정리해줘
           ↓
서버: SKILL.md 내용을 appendSystemPrompt로 주입
           ↓
Claude: 스킬 지시에 따라 실행
```

---

## 모듈 구조

```
src/
  index.js                라이브러리 공개 API (createDriver, runOneShot)
  options/
    spec.js               모든 옵션 정의 (단일 소스)
    parse-argv.js         CLI argv 파서
    validate.js           교차 옵션 유효성 검사
  parsers/
    ansi-strip.js         ANSI 이스케이프 제거
    tui-frame.js          TUI 프레임 파서 (이벤트 생성)
    sentinel.js           완료 sentinel 감지
    pipeline.js           파서 파이프라인 조합
  output/
    text.js               --output-format text 어댑터
    json.js               --output-format json 어댑터
    stream-json.js        --output-format stream-json 어댑터
  pty/
    session.js            단일 PTY 세션 생명주기
    pool.js               워밍업 PTY 풀
  completion/
    detector.js           완료 감지 (sentinel + idle + prompt-box)
bin/
  cli.js                  ocp CLI 진입점
sample/
  server.js               예제 웹 서버
  public/                 채팅 UI
```

---

## 라이선스

MIT
