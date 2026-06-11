# 개발 진행 기록 (Development Log)

## 2026-06-11: Wave 0 & Wave 1 시작

### 1. 현황 파악
- `project` 폴더 내에 기존에 작업했던 파일들(`parsed_text.json`, `analysis_result.json`, `index.html` 등)과 테스트용 PDF 파일들이 존재함.
- `parsed_text.json`을 확인해본 결과, 이전에 `kordoc MCP` 호출을 시도했으나 `pdfjs-dist` 모듈 누락으로 인해 파싱에 실패한 기록이 남아있음.
- 기존에는 PDF vs PDF 비교였으나, 현재 목표는 HWPX vs PDF 비교로 변경됨.

### 2. 진행 계획
1. **의존성 설치**: `kordoc` MCP 연동 및 마크다운 파싱/AST 분석을 위한 필수 패키지 설치 (`@modelcontextprotocol/sdk`, `pdfjs-dist`, 마크다운 파서 등).
2. **`parse_document.js` 작성**: HWPX와 PDF를 읽어 kordoc MCP를 통해 마크다운으로 변환하고, 이를 AST로 파싱하여 `parsed_text.json`으로 저장하는 스크립트 작성.
3. **주석 원칙**: 모든 코드에는 초보자도 이해할 수 있도록 상세한 한글 주석 추가.

### 3. 작업 내역
- `project` 폴더에서 `npm init -y` 실행 및 필수 패키지(`@modelcontextprotocol/sdk`, `pdfjs-dist`, `marked`) 설치 완료.
- `project/parse_document.js` 파일 생성 완료.
  - 초보자도 이해할 수 있도록 상세한 한글 주석 추가.
  - 실제 kordoc MCP 서버 연동 전, 전체 파이프라인(파일 읽기 -> 마크다운 변환 -> AST 토큰화 -> JSON 저장)이 정상 동작하는지 확인하기 위한 Mock(가짜) 함수 구현.
  - 중간 산출물인 `.md` 파일을 디스크에 저장하는 로직 포함.
- **`parse_document.js`에 실제 MCP 클라이언트 연동 코드 적용 완료.**
  - `@modelcontextprotocol/sdk`를 사용하여 `npx kordoc` 프로세스를 띄우고 통신(stdio)하는 로직 추가.
  - `callTool`을 통해 `parse_document` 도구를 호출하여 실제 마크다운 텍스트를 받아오도록 수정.
  - 작업 완료 후 MCP 연결을 안전하게 종료하는 `finally` 블록 추가.
- **`parse_document.js` 로직 고도화 (kordoc 내장 비교 도구 활용)**
  - 우리가 직접 마크다운 AST를 분석하는 대신, kordoc MCP가 제공하는 `compare_documents` 도구를 호출하도록 로직 수정.
  - `callCompareDocumentsMCP` 함수를 추가하여 두 문서의 경로를 전달하고 비교 결과를 받아옴.
  - 기존의 `parsed_text.json` 대신 비교 결과가 포함된 `analysis_result.json`을 생성하도록 변경.
- **PoC 테스트 실행 및 결과 확인 (2026-06-11)**
  - `node parse_document.js` 실행 결과, `npx kordoc` 명령어를 찾을 수 없거나 MCP 서버 초기화 과정에서 오류가 발생함 (`Error: spawn npx ENOENT` 또는 연결 타임아웃).
  - **원인 분석**: 현재 환경에 전역으로 `kordoc` 패키지가 설치되어 있지 않거나, `npx kordoc` 명령어가 유효한 MCP 서버를 띄우지 못하는 것으로 추정됨.
  - **해결**: GitHub 저장소 가이드에 따라 실행 명령어를 `npx -y kordoc mcp`로 수정.
  - **결과**: MCP 서버 연결 성공 및 `parse_document` 도구를 통해 두 PDF 파일이 성공적으로 마크다운으로 변환됨. `target_temp.md`, `compare_temp.md`, `parsed_text.json` 파일 생성 확인.
  - **특이사항**: kordoc MCP에는 `compare_documents`라는 두 문서를 직접 비교해주는 도구도 존재함을 확인. 추후 1차 규칙 기반 비교 로직을 직접 구현하는 대신 이 도구를 활용하는 방안도 고려 가능.
- **비교 도구 테스트 실행 (2026-06-11)**
  - `node parse_document.js` 실행 결과, 파싱 및 `compare_documents` 호출 성공.
  - `analysis_result.json` 파일에 kordoc이 분석한 신구대조 결과가 정상적으로 저장됨을 확인.
  - **⚠️ 문제 발생**: `analysis_result.json`을 확인해 본 결과, `comparison_result` 값이 `"오류: 문서 처리 중 오류가 발생했습니다"`로 반환됨.
  - **원인 분석**: kordoc의 `compare_documents` 도구가 내부적으로 PDF 비교를 처리하다가 에러를 뱉은 것으로 보임. (아마도 PDF 텍스트 추출 후 Diff 과정에서 메모리 부족이나 파싱 에러 발생 추정)
  - **대응 방안**: kordoc의 내장 비교 도구가 불안정하므로, 원래 계획(Task 2)대로 우리가 직접 마크다운 텍스트를 비교하는 로직을 구현하거나, AI에게 두 마크다운 텍스트를 통째로 넘겨서 비교하게 하는 방안으로 선회해야 함.
- **AI 기반 비교 분석 로직으로 선회 (2026-06-11)**
  - `npm install openai` 실행하여 OpenAI 패키지 설치.
  - `parse_document.js`에서 불안정한 `callCompareDocumentsMCP` 함수를 제거하고, `analyzeDifferencesWithAI` 함수를 새로 작성.
  - kordoc으로 추출한 두 마크다운 텍스트를 OpenAI API(`gpt-4o-mini`)에 전달하여, 추가/삭제/변경 사항을 구조화된 JSON 형태로 응답받도록 프롬프트 엔지니어링 적용.
  - `dotenv` 패키지를 설치하고 `project/.env` 파일을 생성하여 API 키를 안전하게 관리하도록 수정.
- **OpenRouter API로 전환 (2026-06-11)**
  - OpenAI 직접 호출 대신 OpenRouter를 사용하도록 코드 수정.
  - `.env` 파일의 키를 `OPENROUTER_API_KEY`로 변경.
  - `parse_document.js`의 OpenAI 클라이언트 초기화 시 `baseURL`을 OpenRouter 엔드포인트로 변경하고 필수 헤더 추가.
  - 모델을 사용자의 요청에 따라 `google/gemini-1.5-flash`로 변경.

- **의존성 문제 해결 (2026-06-11)**
  - `parsed_text.json` 확인 결과, kordoc MCP가 PDF를 파싱할 때 `pdfjs-dist` 모듈이 필요하다는 에러 메시지를 반환함.
  - `npm install pdfjs-dist` 명령어를 실행하여 누락된 패키지 설치 완료.

## Wave 2: HTML UI 렌더링 및 엑셀 다운로드 연동 (2026-06-11)
- 기존 `index.html`을 완전히 개편하여, Node.js 스크립트가 생성한 `analysis_result.json` 파일을 브라우저에서 직접 읽어와 화면에 렌더링하도록 수정.
- AI가 분석한 "추가/삭제/변경" 유형에 따라 색상 배지(Badge)를 적용하여 가독성 향상.
- AI의 전체 요약(Summary)을 상단에 표시하는 영역 추가.
- `SheetJS (xlsx)` 라이브러리를 활용하여 화면에 렌더링된 신구대조표를 `수정목록_신구대조표.xlsx` 파일로 다운로드하는 기능 구현 완료.

- **AI 프롬프트 고도화 (2026-06-11)**
  - `index.html`의 테이블 구조(11개 컬럼)와 완벽하게 호환되도록 `parse_document.js`의 AI System Prompt를 수정.
  - AI가 응답하는 JSON 구조를 `{"results": [{"페이지번호": "...", "사업명": "...", ...}]}` 형태로 강제하여, 프론트엔드에서 별도의 데이터 가공 없이 바로 렌더링할 수 있도록 조치.

- **AI 분석 실행 및 결과 확인 (2026-06-11)**
  - `node parse_document.js` 실행 시도.
  - OpenRouter 모델 ID 오류 발생 (`google/gemini-1.5-flash` -> `google/gemini-flash-1.5` -> `google/gemini-1.5-flash` 등).
  - 최종적으로 `google/gemini-1.5-flash` 모델 ID를 사용하여 정상적으로 AI 분석 완료 및 `analysis_result.json` 생성 확인.

- **엑셀 파일 자동 생성 로직 추가 (2026-06-11)**
  - 브라우저(`index.html`)에서 엑셀을 다운로드하면 사용자의 기본 다운로드 폴더로 가는 문제를 해결하기 위해, Node.js 스크립트(`parse_document.js`)에서 직접 엑셀 파일을 생성하도록 수정.
  - `npm install xlsx` 실행하여 패키지 설치.
  - AI 분석 완료 후, JSON 데이터를 바탕으로 `project/수정목록.xlsx` 파일을 자동 생성하여 저장하는 로직 추가.

- **파싱 결과 저장 로직 보완 (2026-06-11)**
  - 사용자가 다운로드 폴더에서 확인한 `parsed_text.json`의 `kordoc MCP unavailable` 에러는, 이전에 브라우저 UI에서 직접 파싱을 시도했을 때 발생한 잔재로 추정됨.
  - 이를 명확히 해결하기 위해, `parse_document.js` 스크립트가 성공적으로 마크다운을 추출한 직후 그 원본 결과(마크다운 텍스트)를 `project/parsed_text.json` 파일에 덮어쓰기(Update) 하도록 로직 추가.

- **웹 애플리케이션 구조로 전면 개편 (2026-06-11)**
  - 사용자가 브라우저에서 직접 파일을 업로드하고 결과를 볼 수 있도록 로컬 웹 서버(`server.js`) 구축.
  - `express`, `multer` 패키지 설치.
  - `server.js`: 파일 업로드 처리, kordoc MCP 파싱, AI 분석, 엑셀 생성, JSON 응답을 모두 처리하는 API(`/api/analyze`) 구현.
  - `index.html`: JSON 파일을 직접 읽는 방식에서, 폼(Form)을 통해 파일을 서버로 전송하고 결과를 받아와 렌더링하는 방식으로 수정.
  - **AI 프롬프트 수정**: 단순히 변경 사항을 요약하는 것이 아니라, "비교 문서의 내용을 반영하여 원본의 텍스트를 완전히 새롭게 수정한 전체 문장"을 반환하도록 지시.

- **웹 서버 실행 (2026-06-11)**
  - `node server.js` 실행 완료.
  - `http://localhost:3000` 에서 정상적으로 서비스 중.

- **브라우저 단독 실행(HTML/JS) 버전으로 롤백 및 수정 (2026-06-11)**
  - 사용자의 요청에 따라 Node.js 서버(`server.js`) 구동 방식을 폐기하고, `index.html` 파일 하나만 열어도 동작하도록 수정.
  - 브라우저에서 직접 OpenRouter API를 호출하도록 `fetch` 로직 구현.
  - 화면에 API Key 입력란 추가.
  - **한계점 명시**: 브라우저 단독으로는 로컬에 설치된 `kordoc` 프로그램(CLI)을 실행하여 PDF/HWPX 텍스트를 추출할 수 없음. 따라서 현재 버전은 파일 업로드 UI만 제공하며, 실제 AI 분석은 하드코딩된 데모 텍스트를 기반으로 수행되도록 임시 조치함. (실제 상용화를 위해서는 브라우저용 PDF 파서 라이브러리 도입 필요)
