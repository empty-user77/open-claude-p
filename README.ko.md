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

**버전 기록**: [CHANGELOG.md](./CHANGELOG.md) 참조.

---

## 목차

- [설치](#설치)
- [권장 1회 설정](#권장-1회-설정)
- [`claude -p` 와의 알려진 차이점](#claude--p-와의-알려진-차이점)
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

## 권장 1회 설정

**1.1+ 에서는 필요 없습니다.** CLI 기본값이 이미 permissive로 잡혀 있어요:
폴더 신뢰 다이얼로그 자동 수락 ON, `--dangerously-skip-permissions` ON.
`npm install -g open-claude-p` 후 `ocp "..."` 가 바로 동작합니다.

claude의 기본 권한 프롬프트를 다시 받고 싶다면 (PTY 자동화에선 답할 수 없어
모든 도구 호출이 hang 됩니다) opt-out 환경변수로 비활성화:

```bash
export OCP_NO_AUTO_ACCEPT_TRUST=1   # "이 폴더 신뢰?" 다이얼로그에서 abort
export OCP_NO_SKIP_PERMS=1          # claude의 일반 권한 프롬프트 복구
```

> ⚠️ 기본 CLI 설정으로는 `ocp "…"` 호출 한 번이 입력 프롬프트에 따라 Bash,
> Write, Edit 등의 도구를 무확인으로 실행합니다. 개인 워크스테이션이나
> 운영자가 직접 프롬프트를 작성하는 통제된 서비스 계정엔 맞지만, **신뢰
> 안 되는 입력**(공개 챗봇, 프롬프트 인젝션 위험이 있는 RAG 등)이 프롬프트에
> 섞이는 곳에선 절대 그대로 쓰지 마세요. `--allowed-tools`, `OCP_NO_SKIP_PERMS=1`,
> 또는 호출별 검증으로 표면을 좁혀야 합니다.
>
> 라이브러리 기본값 (`createDriver` / `createChatClient`) 은 그대로 보수적
> — 라이브러리 호출자가 명시적으로 권한 우회를 opt-in 합니다.

전체 환경변수 목록은 [docs/cli-reference.md](./docs/cli-reference.md) 참고.

---

## `claude -p` 와의 알려진 차이점

`ocp`는 argv 호환 shim이며, `claude -p`와 완전히 동일한 바이트 결과를 보장하진
않습니다. 다음 케이스에서는 동일 옵션이라도 동작이 달라지니, consumer 파이프라인
연동 시 미리 고려하세요:

- **`~/.claude.json` 상태에 민감.** PTY 레이어가 매 spawn마다 전체 TUI 배너를
  렌더하므로 "1 MCP server needs auth · /mcp", "auto mode unavailable",
  플러그인 업데이트 알림 등도 표시됩니다. `claude -p`는 이런 걸 안 그리지만
  `ocp`는 본질적으로 화면을 거쳐가요. 진짜로 abort 시키진 않지만(`⏺` 또는
  spinner 이벤트가 보일 때까지 대기), 알림 트래픽이 많으면 first-response
  latency가 `OCP_FIRST_RESPONSE_MS`(기본 20s)를 넘겨 spurious 한
  `interactive-required` abort가 날 수 있어요. env를 늘리거나, 안 쓰는
  MCP/플러그인 항목을 `~/.claude.json`에서 제거하세요.

- **1KB 초과 프롬프트는 청크 라이팅 경로 사용.** 다중 KB 한 줄 write로
  claude의 paste 감지가 켜지면 trailing CR이 paste content로 먹혀
  프롬프트가 영영 submit 안 되는 회귀가 있었습니다. 1.1+ 부터는 약 256자
  단위로 짧은 delay를 두고 chunked write — 50–500 ms 추가 latency. 옛
  동작이 필요하면 `OCP_PASTE_MODE=raw`, TUI 입력박스 자체를 우회하려면
  `--input-format=stream-json`.

- **세션 영속화 기본 ON.** 매 턴 `~/.claude/projects/<encoded-cwd>/`에 JSONL
  세션 파일을 기록합니다. 매 턴 컨텍스트를 서버 측에서 재구성하는 stateless
  통합에선 `OCP_NO_SESSION_PERSISTENCE=1` (또는 `--no-session-persistence`)
  로 끄세요. 안 끄면 dead 세션 파일이 쌓이고 `--continue` 조회가 엉뚱한
  이웃 파일을 집을 수 있습니다.

- **데몬은 호출자 종료 후에도 살아남음.** `~/.ocp/d-<hash>.sock`에 daemon이
  attach되어 다음 호출에서 2.5s warmup을 건너뜁니다. `OCP_DAEMON_IDLE_MS`
  (기본 10분) 동안 idle하면 자동 종료. "자식 프로세스는 부모랑 함께 죽어야
  한다"고 기대하는 consumer 앱은 `OCP_NO_DAEMON=1`을 쓰거나 idle 타임아웃을
  더 짧게 설정하세요.

- **Print mode (`--print-mode` / `OCP_PRINT_MODE=1`) 만 PTY를 완전히 우회**
  하고 사실상 `claude --print` + argv pass-through. MCP 서버, 도구 권한
  프롬프트 등 인터랙티브 surface는 전부 동작 안 함 — fallback이나 upstream
  parity 테스트 용도로만.

- **Abort 시 응답 어댑터는 PTY 노이즈를 전달하지 않음.** completionReason이
  `timeout` / `interactive-required` / `trust-required` / `cancelled` /
  `write-failed` / `upstream-exited` 중 하나면, `text`·`stream-json` 어댑터는
  누적된 PTY 콘텐츠를 모델 응답으로 emit하지 않습니다. `stream-json`은
  `result.subtype=error` + `completion=<reason>`만 emit, 짧은 stderr 에러
  메시지에 `detected: <kind>` 힌트를 출력. `claude -p`는 조용히 실패하거나
  당시 갖고 있던 텍스트를 그대로 echo하던 부분과 다릅니다.

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

### 자주 쓰는 것

| 변수명 | 설명 |
|--------|------|
| `OCP_NO_AUTO_ACCEPT_TRUST=1` | 1.1 기본값(폴더 신뢰 자동수락) 비활성화. 다이얼로그가 뜨면 abort 시키고 싶을 때. |
| `OCP_NO_SKIP_PERMS=1` | 1.1 CLI 기본값(`--dangerously-skip-permissions`) 비활성화. claude의 일반 권한 프롬프트가 다시 활성화되며, PTY 자동화가 답할 수 없어 모든 도구 호출이 hang됩니다. |
| `OCP_NO_SESSION_PERSISTENCE=1` | 매 턴 JSONL 세션 파일 기록 비활성화. 매 턴 컨텍스트를 재구성하는 stateless 통합용. |
| `OCP_NO_LIVE=1` | stderr의 live 스피너 비활성화 |
| `OCP_NO_META=1` | trailing meta 푸터(`⏱ … · 🔧 …`) 숨김 |
| `OCP_NO_DAEMON=1` | 매 호출마다 신규 PTY (warm 데몬 사용 안 함) |
| `OCP_DAEMON_IDLE_MS` | warm 데몬이 호출 사이 살아있는 시간. 기본 `600000` (10분). |
| `OCP_MAX_RESPONSE_MS` | hard timeout, 기본 `86400000` (24시간) |
| `OCP_FIRST_RESPONSE_MS` | 프롬프트 전송 후 N ms 안에 진행이 없으면 fail-fast, 기본 `20000` |
| `OCP_PROMPT_BOX_WAIT_MS` | 입력 chevron(`❯`) 등장 대기 최대시간, 기본 `15000` (heavy hook/MCP 로딩 시 증가) |
| `OCP_PASTE_MODE` | 큰 프롬프트의 TUI 입력 방식: `auto`(기본, threshold 초과 시 chunked write), `chunk`(항상 chunk), `bracket`(xterm bracketed paste 마커), `raw`(1.1 이전 atomic write) |
| `OCP_PASTE_THRESHOLD` | `auto` paste 모드가 발동하는 byte 임계값. 기본 `1024` |
| `OCP_DUMP_STALL=1` | abort stderr 메시지에 PTY 화면 tail 포함. 기본 미포함 (호출자 프롬프트가 echo될 수 있어 보안상 opt-in). |
| `OCP_CLAUDE_BIN` | upstream `claude` 바이너리 경로, 기본 `'claude'` |

### 드라이버 옵션 (라이브러리 호출자용)

| 변수명 | 대응 옵션 | 기본값 |
|--------|-----------|--------|
| `OCP_CLAUDE_BIN` | `claudeBin` | `'claude'` |
| `OCP_WARMUP_MS` | `warmupMs` | `2500` |
| `OCP_REUSE_WARMUP_MS` | `reuseWarmupMs` | `200` |
| `OCP_IDLE_MS` | `idleMs` | `1500` |
| `OCP_PRE_IDLE_MS` | `preIdleMs` | `8000` |
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

`open-claude-p/chat` 위에 만든 작은 웹 채팅 UI입니다. 소스는 upstream
git repo의 `sample/`에 있고 **npm tarball에는 번들되지 않습니다** —
대신 패키지가 `ocp-sample`이라는 동반 CLI를 함께 배포해서 필요할 때
원격에서 다운로드합니다. 덕분에 publish된 install은 가볍게 유지하면서도
데모는 한 줄로 시도 가능합니다.

### 빠른 시작

```bash
npm install -g open-claude-p          # 1회만
ocp-sample init demo                   # 다운로드 + npm install
cd demo
ocp-sample start                       # → http://localhost:3000

# 끝나면:
ocp-sample stop
```

### `init`이 하는 일

1. upstream repo를 임시 디렉터리로 shallow-clone.
2. `sample/` 서브트리를 `./<name>/`로 복사 (기본 `./ocp-sample/`).
3. 복사된 `package.json`의 dev 전용 `"open-claude-p": "file:.."` dep을
   실제 semver 범위로 재작성 — 이 CLI 자신의 버전 기반으로 pin해서
   `ocp-sample`이 scaffold한 데모는 항상 같이 publish된 버전과 매칭됨.
4. `npm install --no-audit --no-fund` 실행.
5. `npm link open-claude-p` 시도 — 전역 link 없으면 silent no-op,
   있으면 registry 카피 대신 로컬 dev 소스를 link 사용.

### 서브커맨드

| 명령 | 설명 |
|------|------|
| `ocp-sample init [name]` | `./<name>/`(기본 `ocp-sample`)에 데모 다운로드 + install. 디렉터리가 이미 있고 비어있지 않으면 거부. |
| `ocp-sample start [--port=N]` | CWD에서 `node server.js`를 detached로 띄움. PID는 `.ocp-sample.pid`, stdout/stderr는 `.ocp-sample.log`에 append. `PORT` env도 인식. |
| `ocp-sample stop` | 실행 중인 PID에 SIGTERM (5초 유예 후 SIGKILL). |
| `ocp-sample status` | `running` / `stopped` + PID + URL 출력. |

### cwd에 생성되는 파일

```
demo/
├── .ocp-sample.pid    실행 중 서버 PID (start가 작성, stop이 삭제)
├── .ocp-sample.log    detach된 서버의 stdout/stderr (append)
├── server.js          Express + ocp/chat
├── package.json
├── public/            정적 채팅 UI (index.html, app.js, style.css)
└── node_modules/      `npm install` 결과
```

### 환경변수

| 변수명 | 효과 |
|--------|------|
| `PORT` | `start` 기본 포트(3000) 변경. `--port=N`과 동일. |
| `NO_COLOR=1` | ANSI 색상·스피너 비활성화 — CI나 로그 캡처에 유용. |
| `OCP_SAMPLE_NO_TTY=1` | `NO_COLOR=1`과 동일. |
| `OCP_SAMPLE_REPO` | `init`이 clone할 upstream git URL 변경. 테스트 용. |

### 데모가 시연하는 기능

데모는 의도적으로 작지만 대부분 consumer 앱이 필요로 하는 SDK
부분들을 실제로 행사합니다:

- **대화 영속화** — `chat.send` + `~/.claude/projects/<cwd>/<sid>.jsonl`
- **SSE 스트리밍** — `assistant-text` / `spinner` / `done` 이벤트를 브라우저로
- **스킬 호출** — `/<skill-name>` 타이핑 시 `~/.claude/skills/`의 `SKILL.md` 주입
- **프로세스 관리** — 진행 중인 요청 목록·abort를 `/api/processes`로
- **마크다운 렌더링** — fenced code, 헤딩, 리스트 등을 채팅 버블에서 처리하는 미니 클라이언트 렌더러

`init` 후 `demo/server.js`를 보면 전체 surface가 다 있습니다 — "Express
앱에서 `open-claude-p/chat`을 감싸는 방법" 의 정식 참고 구현으로 보세요.

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
