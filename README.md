# kyw-agent-harness

[![npm version](https://img.shields.io/npm/v/%40kimyw%2Fkyw-agent-harness.svg)](https://www.npmjs.com/package/@kimyw/kyw-agent-harness)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.0-f9f1e1?logo=bun&logoColor=black)](https://bun.sh/)

Claude Code와 Codex CLI를 같은 프로젝트에 연결하는 로컬 MCP harness입니다. 일반적인 에이전트 간 메시지 브리지뿐 아니라, **Claude Fable 5가 기획·설계하고 사용자가 승인한 뒤 Codex가 구현하는 개발 절차**를 상태와 권한 게이트로 관리합니다.

> v3.1부터 구조화된 `Fable 5 설계 → Codex 검토 → 사용자 승인 → Codex 구현 → Fable 검증` 워크플로를 지원합니다.

## 무엇을 제공하나요?

- Claude Code와 Codex CLI 사이의 양방향 메시지 및 첨부파일 전달
- Fable 5와 Codex의 역할 분리: 설계자, 설계 검토자, 구현자, 검증자
- 구현 전 설계 승인과 완료 전 최종 승인 게이트
- 설계 버전, SHA-256 해시, 이벤트 이력이 포함된 작업 산출물
- 기존 프로젝트 분석 시 파일 근거가 있는 `repository-facts` 필수화
- 읽기 전용 단계에서 Git working tree 변경을 감지해 다음 단계 진행 차단
- 설계 변경 시 기존 승인을 무효화하고 재검토·재승인
- Claude 프롬프트 기록 동기화·검색·Markdown 내보내기
- Claude Code 상태 표시줄(HUD)과 환경 진단 명령

## 역할과 진행 흐름

```text
사용자 요구사항
  -> Claude Fable 5: 프로젝트 조사, 요구사항, 아키텍처, 구현 계획
  -> Codex: 설계의 구현 가능성과 누락 검토
  -> 사용자: 설계 승인
  -> Codex: 승인된 설계 구현, 테스트, 결과 보고
  -> Claude Fable 5: 구현의 설계 준수 여부 검증
  -> 사용자: 완료 승인
```

구조화된 작업이 활성화되면 단순 백그라운드 자동응답은 일시 중지됩니다. 실제 Claude/Codex 메인 세션이 프로젝트 도구를 사용해 작업하고, harness는 상태·산출물·승인·메시지를 관리합니다.

## 요구 사항

- [Bun](https://bun.sh/) 1.0 이상
- [Node.js](https://nodejs.org/) 18 이상
- Claude Code
- Codex CLI
- 선택 사항: `tmux` 또는 `psmux` — 새 작업이 생겼을 때 세션 자동 깨우기

## 빠른 시작

### 1. 설치와 프로젝트 초기화

```bash
npm install -g @kimyw/kyw-agent-harness
cd your-project
kah init --fable5
kah doctor
```

`kah init --fable5`는 다음을 설정합니다.

- 프로젝트의 `.mcp.json`에 Claude용 bridge MCP 등록
- Codex MCP 등록 또는 `~/.codex/config.toml` 갱신
- 프로젝트의 `.bridge/workflow.json` 생성
- Claude sampling 모델 힌트를 `claude-fable-5`로 설정

일반 메시지 브리지만 사용하려면 `kah init`을 실행하세요. 여러 작업 흐름을 분리하려면 슬롯을 지정할 수 있습니다.

```bash
kah init --slot architecture --fable5
```

> MCP는 백그라운드 sampling 응답의 실제 모델을 검증할 수 있지만, 대화형 Claude 세션에서 현재 선택된 모델까지 확인하지는 못합니다. 작업 전 Claude UI 또는 `/model`에서 Fable 5가 선택됐는지 확인하세요.

### 2. Claude와 Codex 실행

초기화한 프로젝트에서 Claude Code와 Codex CLI를 각각 별도 터미널로 실행합니다. `kah doctor`가 bridge와 workflow 설정을 모두 통과하는지 먼저 확인하는 것을 권장합니다.

### 3. 작업 생성

신규 프로젝트:

```bash
kah task create --type greenfield --title "주문 관리 서비스" --goal "주문 생성, 결제, 취소를 지원하는 서비스의 기획과 개발 설계"
```

기존 프로젝트 수정:

```bash
kah task create --type existing-change --title "감사 로그 추가" --brief docs/audit-log-request.md
```

터미널 자동 깨우기를 사용할 수 없는 환경에서는 Claude에게 다음과 같이 요청하세요.

```text
get_active_task를 호출하고 next_action에 따라 읽기 전용으로 기획과 설계를 진행해줘.
```

## 상태 흐름과 승인

```text
discovery
  -> design_draft
  -> awaiting_review
  -> awaiting_approval
  -> approved
  -> implementing
  -> awaiting_validation
  -> awaiting_completion_approval
  -> completed
```

- Claude는 `submit_design`으로 완전한 설계 산출물을 제출합니다.
- Codex는 `submit_design_review`로 구현 가능성과 누락을 검토합니다.
- 사용자가 승인하기 전에는 Codex의 `start_implementation`이 실패합니다.
- Codex가 구현 중 설계 문제를 발견하면 `request_design_change`를 호출해야 하며, 기존 승인은 무효화됩니다.
- Claude는 구현 후 `submit_validation`으로 설계 준수 여부를 검증하며 직접 코드를 수정하지 않습니다.
- 설계 리뷰가 기본 2회를 넘으면 모델끼리 반복하지 않고 사용자 결정 단계로 전환됩니다.

### 작업 명령어

| 명령 | 설명 |
| --- | --- |
| `kah task create ...` | 신규 또는 기존 프로젝트 변경 작업 생성 |
| `kah task list` | 모든 작업 요약 조회 |
| `kah task status [task-id]` | 활성 작업 또는 지정 작업의 상태·다음 행동 조회 |
| `kah task approve <task-id>` | 현재 설계 버전 승인 |
| `kah task request-changes <task-id> --reason <text>` | 설계 보완 요청 |
| `kah task complete <task-id>` | Fable 검증 통과 후 완료 승인 |
| `kah task cancel <task-id> [--reason <text>]` | 진행 중인 작업 취소 |

예시:

```bash
kah task status
kah task approve task_abcd1234efgh
kah task request-changes task_abcd1234efgh --reason "롤백과 데이터 마이그레이션 계획 보강"
kah task complete task_abcd1234efgh
```

슬롯마다 동시에 하나의 활성 작업을 둘 수 있습니다. 다른 흐름이 필요하면 `task create`에 `--slot <name>`을 지정하세요.

## 저장되는 설계 산출물

모든 산출물은 버전과 SHA-256 해시를 포함하며 프로젝트 내부에 저장됩니다.

```text
.bridge/tasks/<task-id>/
├─ task.json
└─ artifacts/
   ├─ brief-v1.md
   ├─ requirements-v1.md
   ├─ repository-facts-v1.md
   ├─ architecture-v1.md
   ├─ implementation-plan-v1.md
   ├─ acceptance-criteria-v1.md
   ├─ test-plan-v1.md
   ├─ risks-v1.md
   ├─ codex-review-v1.md
   ├─ design-change-request-v1.md
   ├─ implementation-report-v1.md
   └─ validation-report-v1.md
```

`existing-change` 작업은 실제 파일과 코드 위치를 근거로 정리한 `repository-facts`가 반드시 필요합니다. 설계가 바뀌면 새 버전의 산출물이 생성되며 사용자 재승인을 받아야 합니다.

## 역할별 MCP 도구

| 역할 | 도구 |
| --- | --- |
| Claude/Fable 5 | `get_active_task`, `begin_design`, `submit_design`, `submit_validation` |
| Codex | `get_active_task`, `submit_design_review`, `start_implementation`, `request_design_change`, `report_implementation` |
| 공통 Bridge | `send_message`, `check_messages`, `wait_for_messages`, `reset_session`, `health_check` |

각 도구는 허용된 작업 상태와 호출 역할을 검사합니다. 예를 들어 Claude는 구현을 시작할 수 없고, Codex는 승인되지 않은 설계를 구현 단계로 전환할 수 없습니다.

## 프롬프트 기록과 HUD

```bash
kah prompts sync
kah prompts list
kah prompts export --project my-project --from 2026-07-01
kah statusline
```

- `sync`: Claude의 `history.jsonl`을 로컬 archive로 증분 백업
- `list`: 프로젝트별 프롬프트 수와 최근 활동 요약
- `export`: 날짜·프로젝트·키워드 조건으로 Markdown 내보내기
- `statusline`: Claude Code에 bridge 상태 HUD 설치

## 안전장치와 한계

- Broker는 임의 토큰 인증을 사용하며 `127.0.0.1`에서만 실행됩니다.
- 대화, 첨부파일, 작업 상태와 설계 산출물은 프로젝트의 `.bridge/`에 저장됩니다.
- 읽기 전용 단계의 Git fingerprint는 작업 시작 당시 존재하던 변경까지 포함해 working tree 변화를 감지합니다.
- 이 감지는 단계 전환을 차단하는 workflow 안전장치이며 Claude Code 자체의 파일 쓰기 권한을 운영체제 수준에서 차단하지는 않습니다.
- 중요한 저장소에서는 Claude 권한 설정, 보호 브랜치, 별도 Git worktree를 함께 사용하세요.
- `.bridge/`와 `~/.claude/prompt-history/`는 Git에 커밋하거나 외부에 공유하지 마세요. 대상 프로젝트의 `.gitignore`에도 `.bridge/`를 추가하는 것을 권장합니다.

## 문제 해결

먼저 다음 명령으로 설치 경로, MCP 등록, broker와 workflow 설정을 확인합니다.

```bash
kah doctor
```

- **Claude가 작업을 자동으로 시작하지 않음**: `tmux`/`psmux`가 없다면 위의 `get_active_task` 요청을 Claude 세션에 직접 입력합니다.
- **모델 불일치 오류**: Claude에서 `/model`로 Fable 5를 선택한 뒤 MCP 세션을 다시 시작합니다.
- **읽기 전용 변경 감지 오류**: 해당 단계가 시작된 시점의 Git working tree 상태로 복원한 뒤 다시 호출합니다.
- **활성 작업이 이미 있음**: 기존 작업을 완료·취소하거나 새 슬롯으로 작업을 생성합니다.

## 개발

```bash
git clone https://github.com/kimyeongwoo/kyw-agent-harness.git
cd kyw-agent-harness
bun install
bun test --max-concurrency 1
bun run build
```

- GitHub: [kimyeongwoo/kyw-agent-harness](https://github.com/kimyeongwoo/kyw-agent-harness)
- npm: [@kimyw/kyw-agent-harness](https://www.npmjs.com/package/@kimyw/kyw-agent-harness)
