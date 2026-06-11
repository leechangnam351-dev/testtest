# 문서 개정 분석기

## 설치 방법
1. Node.js 18+ 설치
2. 의존성 설치
   - 루트: `npm install`
   - 프로젝트: `cd project && npm install`

## 필요한 환경변수
`project/.env` 파일 생성:

- `OPENROUTER_API_KEY` : OpenRouter API 키
- `DEFAULT_MODEL_ID` (선택) : 기본 모델 ID (예: `openai/gpt-5.3-chat`)

예시는 `project/.env.example` 참고.

## 실행 방법
1. `cd project`
2. `node server.js`
3. 브라우저에서 `http://localhost:3000` 접속

## 실행 명령어
- 개발 실행: `node server.js`
