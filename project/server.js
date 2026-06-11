const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { OpenAI } = require('openai');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = 3000;

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const ANALYSIS_CACHE_PATH = path.join(__dirname, 'analysis_cache.json');
let analysisCache = {};
try {
  if (fs.existsSync(ANALYSIS_CACHE_PATH)) {
    analysisCache = JSON.parse(fs.readFileSync(ANALYSIS_CACHE_PATH, 'utf8')) || {};
  }
} catch (_) {
  analysisCache = {};
}

app.use(express.static(__dirname));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

const upload = multer({ storage });

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function writeAnalysisCache() {
  try {
    fs.writeFileSync(ANALYSIS_CACHE_PATH, JSON.stringify(analysisCache, null, 2), 'utf8');
  } catch (e) {
    log(`경고: analysis_cache.json 저장 실패 (${e.message})`);
  }
}

function normalizeDedupText(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKoreanFilename(name) {
  // multipart 업로드 과정에서 latin1로 깨진 한글 파일명을 UTF-8로 복원 시도
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    // 복원 결과가 정상 한글/영문이면 사용, 아니면 원본 유지
    if (decoded && !decoded.includes('�')) return decoded;
  } catch (_) {}
  return name;
}

function fallbackExtractText(filePath) {
  // 바이너리 원문을 억지로 텍스트화하면 한글이 깨져 가독성이 크게 떨어짐.
  // 따라서 fallback에서는 깨진 문자열 대신 명시적인 안내 텍스트만 반환.
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    return 'PDF 바이너리 fallback: kordoc 파서 오류로 본문 추출에 실패했습니다. (doc.destroy 오류)';
  }
  if (ext === '.hwpx' || ext === '.hwp') {
    return 'HWPX/HWP fallback: kordoc 파서 제한으로 본문 추출에 실패했습니다. (ZIP 엔트리/용량 제한 가능)';
  }
  return '대체 텍스트 추출 실패';
}

async function callKordocParse(mcpClient, filePath) {
  const result = await mcpClient.callTool({
    name: 'parse_document',
    arguments: { file_path: filePath },
  });

  if (!result?.content?.length) {
    throw new Error('kordoc parse_document 응답이 비어 있습니다.');
  }

  const text = result.content
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('kordoc parse_document 텍스트 결과가 비어 있습니다.');
  }

  return text;
}

async function callToolText(mcpClient, name, args) {
  const result = await mcpClient.callTool({ name, arguments: args });
  const text = (result?.content || [])
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .join('\n')
    .trim();
  return {
    text,
    isError: !!result?.isError,
    raw: result,
  };
}

function looksLikeFailureText(text) {
  if (!text) return true;
  const t = text.toLowerCase();
  return (
    t.includes('파싱 실패') ||
    t.includes('zip 엔트리 수 초과') ||
    t.includes('doc.destroy is not a function') ||
    t.includes('error:')
  );
}

async function extractPdfTextDirect(filePath, displayName) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjs.getDocument({ data }).promise;
  const chunks = [`# ${displayName}`];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = (content.items || [])
      .map((it) => (typeof it.str === 'string' ? it.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (text) {
      chunks.push(`\n\n## [pages ${i}-${i}]\n\n${text}`);
    }
  }

  if (chunks.join('').trim().length < 20) {
    throw new Error('직접 PDF 텍스트 추출 결과가 너무 짧습니다.');
  }

  return chunks.join('');
}

async function directParseWithoutKordoc(filePath, displayName) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') {
    return {
      markdown: await extractPdfTextDirect(filePath, displayName),
      parser: 'direct.pdfjs',
      detect: `${filePath}: pdf`,
      metadata: '{"format":"pdf","parser":"pdfjs-direct"}',
    };
  }

  throw new Error('AI분석(직접비교) 모드는 현재 PDF 파일만 지원합니다.');
}

async function robustParse(mcpClient, filePath, displayName) {
  // 1) 형식/메타 먼저 확인
  const detected = await callToolText(mcpClient, 'detect_format', { file_path: filePath }).catch(() => ({ text: '', isError: true }));
  const metadata = await callToolText(mcpClient, 'parse_metadata', { file_path: filePath }).catch(() => ({ text: '', isError: true }));

  // 2) 페이지 분할 파싱 우선 시도 (누락 감소 목적)
  const pageRanges = [
    '1-20','21-40','41-60','61-80','81-100','101-120','121-140','141-160','161-180','181-220','221-280','281-360','361-500'
  ];
  const parts = [];
  for (const pages of pageRanges) {
    const part = await callToolText(mcpClient, 'parse_pages', { file_path: filePath, pages }).catch((e) => ({ text: String(e.message || ''), isError: true }));
    if (!part.isError && part.text && !looksLikeFailureText(part.text)) {
      parts.push(`\n\n## [pages ${pages}]\n\n${part.text}`);
    }
  }

  if (parts.length > 0) {
    return {
      markdown: `# ${displayName}${parts.join('')}`,
      parser: 'kordoc.parse_pages',
      detect: detected.text,
      metadata: metadata.text,
    };
  }

  // 3) 전체 파싱 재시도
  const full = await callToolText(mcpClient, 'parse_document', { file_path: filePath }).catch((e) => ({ text: String(e.message || ''), isError: true }));
  if (!full.isError && !looksLikeFailureText(full.text)) {
    return {
      markdown: full.text,
      parser: 'kordoc.parse_document',
      detect: detected.text,
      metadata: metadata.text,
    };
  }

  // 4) 전부 실패 시에도 '빈껍데기 금지'를 위해 대체 추출로 최소한의 본문을 만들어 저장
  const fallback = fallbackExtractText(filePath);
  if (fallback && fallback.trim().length > 0) {
    const md = `# ${displayName}\n\n` +
      `> ⚠️ Kordoc 원본 파싱 실패. 대체 텍스트 추출 결과입니다.\n` +
      `> detect: ${detected.text || 'unknown'}\n\n` +
      fallback;
    return {
      markdown: md,
      parser: 'fallback_extract',
      detect: detected.text,
      metadata: metadata.text,
    };
  }

  throw new Error(`kordoc 파싱 실패 및 대체 추출 실패: ${displayName} (detect=${detected.text || 'unknown'})`);
}

function buildParseAudit(targetMarkdown, compareParsed) {
  const requiredKeywords = ['대상', '내용', '방법', '문의', '지원', '신청'];

  function countKeywords(text) {
    const stats = {};
    for (const k of requiredKeywords) {
      const re = new RegExp(k, 'g');
      const m = text.match(re);
      stats[k] = m ? m.length : 0;
    }
    return stats;
  }

  return {
    generatedAt: new Date().toISOString(),
    target: {
      length: targetMarkdown.length,
      keywordCounts: countKeywords(targetMarkdown),
    },
    compare: compareParsed.map((c) => ({
      fileName: c.fileName,
      parser: c.parser,
      length: c.markdown.length,
      keywordCounts: countKeywords(c.markdown),
    })),
    note: '키워드 빈도는 누락 가능성 점검용 참고치입니다.'
  };
}

async function parseWithFallback(mcpClient, filePath, fileNameForTitle) {
  try {
    const md = await callKordocParse(mcpClient, filePath);
    return { markdown: md, parser: 'kordoc' };
  } catch (err) {
    const msg = String(err.message || 'unknown');
    const fallback = fallbackExtractText(filePath);
    const md = `# ${fileNameForTitle}\n\n` +
      `> ⚠️ Kordoc 파싱 실패로 대체 추출 사용\n` +
      `> 원인: ${msg}\n\n` +
      fallback;
    return { markdown: md, parser: `fallback (${msg})` };
  }
}

function normalizeBizNameForMatch(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .replace(/[\s·ㆍ\-_/]/g, '')
    .replace(/(지원|지급|사업|제도)$/g, '')
    .trim();
}

function scoreCandidate(baseName, candidateName) {
  const a = normalizeBizNameForMatch(baseName);
  const b = normalizeBizNameForMatch(candidateName);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 85;

  // 간단한 문자 중첩 점수(0~70)
  const setA = new Set(a.split(''));
  const setB = new Set(b.split(''));
  const inter = [...setA].filter((ch) => setB.has(ch)).length;
  const union = new Set([...setA, ...setB]).size || 1;
  return Math.floor((inter / union) * 70);
}

function filledUpdateScore(row) {
  const keys = ['대상수정내용', '내용수정내용', '방법수정내용', '문의수정내용', '사업담당자'];
  return keys.reduce((acc, k) => acc + (toText(row?.[k]) ? 1 : 0), 0);
}

async function analyzeWithAI({ targetMarkdown, compareMarkdown, compareFileName, targetRows, apiKeyOverride, modelIdOverride }) {
  const apiKey = apiKeyOverride || process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY가 .env에 없습니다.');

  const modelId = modelIdOverride || 'openai/gpt-5.3-chat';

  const openai = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
    defaultHeaders: {
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'kordoc-compare-app',
    },
  });

  const systemPrompt = `
너는 문서 신구대조 전문가다.
수정대상 문서와 비교대상 문서를 비교하여, 수정대상 기준으로 달라진 내용을 표 형태 JSON으로 반환해라.
반드시 아래 형식의 JSON 객체만 반환:
{
  "analysis": {
    "results": [
      {
        "페이지번호": "",
        "사업명": "",
        "대상": "",
        "내용": "",
        "방법": "",
        "문의": "",
        "대상수정내용": "",
        "내용수정내용": "",
        "방법수정내용": "",
        "문의수정내용": "",
        "사업담당자": ""
      }
    ]
  }
}

규칙:
- 반드시 targetRows의 각 항목마다 results 1행씩 반환한다. (행 수 동일)
- 결과의 페이지번호/사업명/대상/내용/방법/문의는 targetRows 값을 우선 유지한다.
- 비교대상에서 변경/추가된 최신 문장을 반영해 대상수정내용/내용수정내용/방법수정내용/문의수정내용/사업담당자를 채운다.
- 사업명은 완전 일치가 아니어도 의미가 같으면 매칭한다. 예: "에너지바우처" ≈ "에너지바우처 지급"
- 변경 근거가 없으면 해당 수정내용은 빈 문자열로 둔다.
- JSON 이외 텍스트는 절대 출력하지 않는다.
`;

  const compactTargetRows = (targetRows || []).map((r) => ({
    페이지번호: toText(r.페이지번호),
    사업명: toText(r.사업명),
    대상: toText(r.대상),
    내용: toText(r.내용),
    방법: toText(r.방법),
    문의: toText(r.문의),
    사업담당자: toText(r.사업담당자),
  }));

  const userPrompt = `
[비교대상 파일명]
${compareFileName}

[수정대상 사업목록(JSON)]
${JSON.stringify(compactTargetRows).slice(0, 26000)}

[수정대상 Markdown]
${targetMarkdown.slice(0, 18000)}

[비교대상 Markdown]
${compareMarkdown.slice(0, 18000)}
`;

  const resp = await openai.chat.completions.create({
    model: modelId,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  });

  const content = resp?.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content);
  const results = parsed?.analysis?.results;
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error('AI 결과의 analysis.results가 비어 있습니다.');
  }

  return results;
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findAllIndices(text, token, limit = 20) {
  const out = [];
  if (!text || !token) return out;
  const re = new RegExp(escapeRegExp(token), 'ig');
  let m;
  while ((m = re.exec(text)) && out.length < limit) {
    out.push(m.index);
  }
  return out;
}

function scoreWindowByChangeHints(windowText) {
  const hints = ['변경 전', '변경 후', '시행일', '관련 법규', '확대', '인상', '완화', '신설', '지급'];
  let score = 0;
  for (const h of hints) {
    const m = windowText.match(new RegExp(escapeRegExp(h), 'g'));
    if (m) score += m.length;
  }
  return score;
}

function getCompareSnippetByBizName(compareMarkdown, bizName, baseRow = {}) {
  const text = String(compareMarkdown || '');
  const name = String(bizName || '').trim();
  if (!text) return '';

  const rowTokens = [baseRow?.대상, baseRow?.내용, baseRow?.방법, baseRow?.문의]
    .map((v) => String(v || ''))
    .join(' ')
    .split(/[^가-힣A-Za-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 8);

  const tokens = [...name
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 3), ...rowTokens]
    .slice(0, 10);

  let idx = -1;
  let bestScore = -1;
  for (const t of tokens) {
    const indices = findAllIndices(text, t, 20);
    for (const cand of indices) {
      const s = Math.max(0, cand - 2500);
      const e = Math.min(text.length, cand + 9000);
      const windowText = text.slice(s, e);
      const score = scoreWindowByChangeHints(windowText);
      if (score > bestScore) {
        bestScore = score;
        idx = cand;
      }
    }
  }

  if (idx < 0) {
    // 사업명이 안 잡히면 앞부분 일부라도 전달
    return text.slice(0, 10000);
  }

  const start = Math.max(0, idx - 2500);
  const end = Math.min(text.length, idx + 9000);
  return text.slice(start, end);
}

async function analyzeSingleRowWithAI({ baseRow, compareMarkdown, compareFileName, apiKeyOverride, modelIdOverride }) {
  const apiKey = apiKeyOverride || process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY가 .env에 없습니다.');

  const modelId = modelIdOverride || 'openai/gpt-5.3-chat';

  const openai = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
    defaultHeaders: {
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'kordoc-compare-app',
    },
  });

  const snippet = getCompareSnippetByBizName(compareMarkdown, baseRow?.사업명, baseRow);

  const systemPrompt = `
너는 문서 신구대조 전문가다.
수정대상 1개 사업행과 비교대상 문맥을 비교해 수정 컬럼만 채운다.
반드시 JSON 객체만 반환한다:
{
  "row": {
    "대상수정내용": "",
    "내용수정내용": "",
    "방법수정내용": "",
    "문의수정내용": "",
    "사업담당자": ""
  }
}

규칙:
- 사업명 유사어를 허용한다. 예: "에너지바우처"와 "에너지바우처 지급"은 동일 사업으로 본다.
- 가능한 경우 반드시 '얼마나/어떻게'를 구체적으로 쓴다. (금액, 비율, 대상범위, 시행일, 연락처 등)
- 표현은 "기존 → 변경" 형태로 작성한다.
- baseRow의 원문 컬럼(대상/내용/방법/문의)은 변경하지 않는다.
- 수정근거를 못 찾으면 빈칸 대신 "비교문서에서 명시 근거 미확인"이라고 채운다.
`;

  const userPrompt = `
[비교대상 파일명]
${compareFileName}

[수정대상 사업행]
${JSON.stringify(baseRow, null, 2)}

[비교대상 관련 문맥]
${snippet}
`;

  const resp = await openai.chat.completions.create({
    model: modelId,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  });

  const content = resp?.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content);
  const row = parsed?.row || {};
  const result = {
    대상수정내용: toText(row.대상수정내용),
    내용수정내용: toText(row.내용수정내용),
    방법수정내용: toText(row.방법수정내용),
    문의수정내용: toText(row.문의수정내용),
    사업담당자: toText(row.사업담당자),
  };

  // 완전 빈 응답 방지: 최소 안내 문구 채움
  if (!result.대상수정내용) result.대상수정내용 = '비교문서에서 명시 근거 미확인';
  if (!result.내용수정내용) result.내용수정내용 = '비교문서에서 명시 근거 미확인';
  if (!result.방법수정내용) result.방법수정내용 = '비교문서에서 명시 근거 미확인';
  if (!result.문의수정내용) result.문의수정내용 = '비교문서에서 명시 근거 미확인';

  return result;
}

async function buildRevisionListWithAI({ targetMarkdown, compareMarkdown, compareFileName, apiKeyOverride, modelIdOverride }) {
  const apiKey = apiKeyOverride || process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY가 .env에 없습니다.');

  const modelId = modelIdOverride || 'openai/gpt-5.3-chat';
  const openai = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
    defaultHeaders: {
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'kordoc-compare-app',
    },
  });

  const systemPrompt = `
당신은 정부 안내서 개정 분석 전문가이다.

목표는 문서 차이를 찾는 것이 아니라
기존 안내서(target)를 최신 안내서(compare)에 맞게 수정하기 위해
수정목록을 작성하는 것이다.

중요 원칙
1. 동일 서비스를 먼저 매칭한다.
2. 신규 서비스와 삭제 서비스는 별도로 구분한다.
3. 단순 문장 표현 차이는 무시한다.
4. 실제 정책 변경만 수정사항으로 기록한다.

실제 정책 변경의 예
- 지원대상 변경
- 지원금액 변경
- 선정기준 변경
- 소득기준 변경
- 재산기준 변경
- 신청방법 변경
- 신청기관 변경
- 문의처 변경
- 지원기간 변경
- 신규 제도 도입
- 제도 폐지

반드시 JSON만 반환:
{
  "rows": [
    {
      "서비스명": "",
      "변경항목": "",
      "기존내용": "",
      "변경내용": "",
      "변경사유": ""
    }
  ]
}

규칙:
- 변경이 명확한 건만 기록한다.
- 가능한 경우 "기존 → 변경"이 드러나게 구체 수치/기준/대상범위를 쓴다.
- 근거가 부족하면 해당 항목은 제외한다.
`;

  const userPrompt = `
[비교대상 파일명]
${compareFileName}

[수정대상 Markdown]
${targetMarkdown.slice(0, 50000)}

[비교대상 Markdown]
${compareMarkdown.slice(0, 90000)}
`;

  const resp = await openai.chat.completions.create({
    model: modelId,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  });

  const content = resp?.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content);
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  return rows
    .map((r) => ({
      서비스명: toText(r.서비스명),
      변경항목: toText(r.변경항목),
      기존내용: toText(r.기존내용),
      변경내용: toText(r.변경내용),
      변경사유: toText(r.변경사유),
    }))
    .filter((r) => r.서비스명 && r.변경항목 && r.변경내용);
}

function buildRevisionListFallback(mergedResults) {
  const out = [];
  for (const r of (mergedResults || [])) {
    const service = toText(r.사업명);
    if (!service) continue;

    const pushRow = (item, oldV, newV) => {
      const n = toText(newV);
      if (!n || n === '비교문서에서 명시 근거 미확인') return;
      out.push({
        서비스명: service,
        변경항목: item,
        기존내용: toText(oldV),
        변경내용: n,
        변경사유: '최신 안내서 반영',
      });
    };

    pushRow('지원대상 변경', r.대상, r.대상수정내용);
    pushRow('지원내용 변경', r.내용, r.내용수정내용);
    pushRow('신청방법/기관 변경', r.방법, r.방법수정내용);
    pushRow('문의처 변경', r.문의, r.문의수정내용);
  }
  return out;
}

async function extractTargetRowsWithAI({ targetMarkdown, apiKeyOverride, modelIdOverride }) {
  const apiKey = apiKeyOverride || process.env.OPENROUTER_API_KEY;
  if (!apiKey) return [];

  const modelId = modelIdOverride || 'openai/gpt-5.3-chat';
  const openai = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
    defaultHeaders: {
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'kordoc-compare-app',
    },
  });

  const systemPrompt = `
너는 복지사업 데이터 추출 전문가다.
입력된 Markdown에서 사업 단위를 추출해 아래 JSON만 반환하라.
{
  "rows": [
    {
      "페이지번호": "",
      "사업명": "",
      "대상": "",
      "내용": "",
      "방법": "",
      "문의": "",
      "사업담당자": ""
    }
  ]
}

규칙:
- 각 사업을 1행으로 만든다.
- 대상/내용/방법/문의가 일부만 보여도 가능한 범위에서 채운다.
- 사업명이 비어있는 행은 만들지 않는다.
- JSON 외 텍스트를 출력하지 않는다.
`;

  const userPrompt = `[수정대상 Markdown]\n${targetMarkdown.slice(0, 60000)}`;

  const resp = await openai.chat.completions.create({
    model: modelId,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  });

  const content = resp?.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content);
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  return rows
    .map((r) => ({
      페이지번호: toText(r.페이지번호),
      사업명: toText(r.사업명),
      대상: toText(r.대상),
      내용: toText(r.내용),
      방법: toText(r.방법),
      문의: toText(r.문의),
      대상수정내용: '',
      내용수정내용: '',
      방법수정내용: '',
      문의수정내용: '',
      사업담당자: toText(r.사업담당자),
    }))
    .filter((r) => toText(r.사업명));
}

function saveExcel(results) {
  const wb = XLSX.utils.book_new();
  const first = (results || [])[0] || {};
  const isRevision = Object.prototype.hasOwnProperty.call(first, '서비스명');

  const wsData = isRevision
    ? [['서비스명', '변경항목', '기존내용', '변경내용', '변경사유']]
    : [[
      '페이지번호', '사업명', '대상', '내용', '방법', '문의',
      '대상수정내용', '내용수정내용', '방법수정내용', '문의수정내용', '사업담당자'
    ]];

  results.forEach((r) => {
    if (isRevision) {
      wsData.push([
        r.서비스명 || '',
        r.변경항목 || '',
        r.기존내용 || '',
        r.변경내용 || '',
        r.변경사유 || '',
      ]);
    } else {
      wsData.push([
        r.페이지번호 || '',
        r.사업명 || '',
        r.대상 || '',
        r.내용 || '',
        r.방법 || '',
        r.문의 || '',
        r.대상수정내용 || '',
        r.내용수정내용 || '',
        r.방법수정내용 || '',
        r.문의수정내용 || '',
        r.사업담당자 || '',
      ]);
    }
  });

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, '신구대조표');

  const primaryPath = path.join(__dirname, '수정목록.xlsx');
  try {
    XLSX.writeFile(wb, primaryPath);
    return primaryPath;
  } catch (e) {
    // 엑셀이 열려 있어 잠금(EBUSY) 발생 시 타임스탬프 파일로 저장해 분석 자체는 계속 진행
    const code = String(e?.code || '');
    const isBusy = code === 'EBUSY' || String(e?.message || '').toLowerCase().includes('busy');
    if (!isBusy) throw e;

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fallbackPath = path.join(__dirname, `수정목록_${ts}.xlsx`);
    XLSX.writeFile(wb, fallbackPath);
    log(`경고: 수정목록.xlsx 파일이 사용 중이라 ${path.basename(fallbackPath)} 로 저장했습니다.`);
    return fallbackPath;
  }
}

function toText(v) {
  return String(v || '').trim();
}

function isNonEmptyBusinessRow(row) {
  const keys = ['페이지번호', '사업명', '대상', '내용', '방법', '문의', '대상수정내용', '내용수정내용', '방법수정내용', '문의수정내용', '사업담당자'];
  return keys.some((k) => toText(row?.[k]).length > 0);
}

function parseMarkdownTableRows(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const rows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('|')) continue;

    const headerCells = line.split('|').map((x) => x.trim()).filter(Boolean);
    const hasBusinessHeader = headerCells.some((c) => /사업명|사업|대상|내용|방법|문의|페이지/.test(c));
    if (!hasBusinessHeader) continue;

    const divider = lines[i + 1] || '';
    if (!/^\s*\|?\s*[-:]+/.test(divider)) continue;

    let j = i + 2;
    while (j < lines.length && lines[j].includes('|')) {
      const dataCells = lines[j].split('|').map((x) => x.trim());
      const values = dataCells.filter((_, idx) => idx > 0 && idx < dataCells.length - 1);
      if (values.length > 0) {
        const row = {
          페이지번호: '',
          사업명: '',
          대상: '',
          내용: '',
          방법: '',
          문의: '',
          대상수정내용: '',
          내용수정내용: '',
          방법수정내용: '',
          문의수정내용: '',
          사업담당자: '',
        };

        headerCells.forEach((h, idx) => {
          const v = values[idx] || '';
          if (/페이지/.test(h)) row.페이지번호 = v;
          else if (/사업명|사업/.test(h)) row.사업명 = v;
          else if (/대상/.test(h)) row.대상 = v;
          else if (/내용/.test(h)) row.내용 = v;
          else if (/방법/.test(h)) row.방법 = v;
          else if (/문의/.test(h)) row.문의 = v;
          else if (/담당/.test(h)) row.사업담당자 = v;
        });

        if (isNonEmptyBusinessRow(row)) rows.push(row);
      }
      j += 1;
    }
    i = j - 1;
  }

  return rows;
}

function parseKeyValueBusinessRows(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const rows = [];
  let current = null;

  const flush = () => {
    if (current && isNonEmptyBusinessRow(current)) rows.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const m = line.match(/^(페이지번호|사업명|대상|내용|방법|문의|사업담당자)\s*[:：]\s*(.+)$/);
    if (!m) continue;

    const key = m[1];
    const val = m[2].trim();

    if (key === '사업명') {
      flush();
      current = {
        페이지번호: '', 사업명: '', 대상: '', 내용: '', 방법: '', 문의: '',
        대상수정내용: '', 내용수정내용: '', 방법수정내용: '', 문의수정내용: '', 사업담당자: ''
      };
    }

    if (!current) {
      current = {
        페이지번호: '', 사업명: '', 대상: '', 내용: '', 방법: '', 문의: '',
        대상수정내용: '', 내용수정내용: '', 방법수정내용: '', 문의수정내용: '', 사업담당자: ''
      };
    }

    current[key] = val;
  }

  flush();
  return rows;
}

function parseHeadingBusinessRows(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const rows = [];
  const genericTitles = new Set([
    '생활에 어려움을',
    '겪고 계신가요?',
    '생계를 유지하기가 힘들 때',
    '생활에 갑작스러운 위기가 닥쳤을 때',
    '주택문제로 어려움을 겪을 때',
    '재정적인 도움이 필요할 때',
    '일상의 불편함, 부족함을 해소하고 싶을 때',
    '생계 지원',
  ]);

  let current = null;
  let currentSection = '';
  let currentPage = '';

  const newRow = (name) => ({
    페이지번호: currentPage,
    사업명: name,
    대상: '',
    내용: '',
    방법: '',
    문의: '',
    대상수정내용: '',
    내용수정내용: '',
    방법수정내용: '',
    문의수정내용: '',
    사업담당자: '',
  });

  const flush = () => {
    if (current && isNonEmptyBusinessRow(current) && toText(current.사업명)) {
      rows.push(current);
    }
    current = null;
    currentSection = '';
  };

  const append = (key, text) => {
    if (!current || !key || !text) return;
    const prev = toText(current[key]);
    current[key] = prev ? `${prev} ${text}` : text;
  };

  const isBusinessHeading = (name, idx) => {
    if (!name || genericTitles.has(name)) return false;
    if (name.length > 60) return false;
    if (!/(지원|급여|제도|사업|바우처|서비스|보장|수당|대출|바처)/.test(name)) return false;

    // 실제 사업 섹션인지 확인: 근방에 "## 대상"/"## 내용"이 있으면 우선 통과,
    // 없더라도 키워드 기반 제목은 사업명 후보로 허용한다.
    const lookahead = lines.slice(idx + 1, Math.min(idx + 80, lines.length)).join('\n');
    if (/##\s*대상|##\s*내용/.test(lookahead)) return true;
    return true;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const pageMatch = line.match(/^##\s*\[pages\s+([^\]]+)\]/i);
    if (pageMatch) {
      currentPage = toText(pageMatch[1]);
      continue;
    }

    const h1 = line.match(/^#\s+(.+)$/);
    if (h1) {
      const title = toText(h1[1]);
      if (isBusinessHeading(title, i)) {
        flush();
        current = newRow(title);
        continue;
      }
    }

    const h2 = line.match(/^##\s*(대상|내용|방법|문의)\s*$/);
    if (h2 && current) {
      currentSection = h2[1];
      continue;
    }

    if (current && currentSection) {
      if (/^#/.test(line)) continue;
      append(currentSection, line.replace(/^[-•]\s*/, ''));
    }
  }

  flush();
  return rows;
}

function extractTargetBusinessRows(targetMarkdown) {
  const fromHeading = parseHeadingBusinessRows(targetMarkdown);
  const fromTable = parseMarkdownTableRows(targetMarkdown);
  const fromKv = parseKeyValueBusinessRows(targetMarkdown);

  const merged = [...fromHeading, ...fromTable, ...fromKv].filter(isNonEmptyBusinessRow);
  const unique = [];
  const seen = new Set();
  for (const row of merged) {
    const name = toText(row.사업명).replace(/\s+/g, ' ').trim();
    const page = toText(row.페이지번호).replace(/\s+/g, ' ').trim();
    const key = `${name}__${page}`;
    if (!name) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      페이지번호: toText(row.페이지번호),
      사업명: name,
      대상: toText(row.대상),
      내용: toText(row.내용),
      방법: toText(row.방법),
      문의: toText(row.문의),
      대상수정내용: toText(row.대상수정내용),
      내용수정내용: toText(row.내용수정내용),
      방법수정내용: toText(row.방법수정내용),
      문의수정내용: toText(row.문의수정내용),
      사업담당자: toText(row.사업담당자),
    });
  }
  return unique;
}

function mergeByTargetBaseRows(targetRows, analysisRows) {
  const safeAnalysis = (analysisRows || []).filter(isNonEmptyBusinessRow);
  if (!Array.isArray(targetRows) || targetRows.length === 0) {
    return safeAnalysis;
  }

  return targetRows.map((base) => {
    const baseName = toText(base.사업명);
    const ranked = safeAnalysis
      .map((a) => ({
        row: a,
        nameScore: scoreCandidate(baseName, toText(a.사업명)),
        fillScore: filledUpdateScore(a),
      }))
      .sort((x, y) => {
        if (y.nameScore !== x.nameScore) return y.nameScore - x.nameScore;
        return y.fillScore - x.fillScore;
      });

    const matched = ranked.length > 0 && ranked[0].nameScore >= 45 ? ranked[0].row : {};

    return {
      페이지번호: toText(base.페이지번호),
      사업명: toText(base.사업명),
      대상: toText(base.대상),
      내용: toText(base.내용),
      방법: toText(base.방법),
      문의: toText(base.문의),
      대상수정내용: toText(matched.대상수정내용),
      내용수정내용: toText(matched.내용수정내용),
      방법수정내용: toText(matched.방법수정내용),
      문의수정내용: toText(matched.문의수정내용),
      사업담당자: toText(base.사업담당자 || matched.사업담당자),
    };
  }).filter(isNonEmptyBusinessRow);
}

app.post(
  '/api/analyze',
  upload.fields([
    { name: 'targetFile', maxCount: 1 },
    { name: 'compareFiles', maxCount: 20 },
  ]),
  async (req, res) => {
    let mcpClient;
    try {
      const apiKeyOverride = String(req.body?.apiKey || '').trim();
      const modelIdOverride = String(req.body?.modelId || '').trim();
      const analysisMode = String(req.body?.analysisMode || 'kordoc_ai').trim();

      const targetFile = req.files?.targetFile?.[0];
      const compareFiles = req.files?.compareFiles || [];
      const targetDisplayName = normalizeKoreanFilename(targetFile.originalname);


      if (!targetFile) throw new Error('수정대상 파일이 없습니다.');
      if (compareFiles.length === 0) throw new Error('비교대상 파일이 없습니다.');

      let targetParsed;
      const compareParsed = [];

      if (analysisMode === 'kordoc_ai') {
        log('kordoc MCP 서버 연결 시작');
        const transport = new StdioClientTransport({ command: 'npx', args: ['-y', 'kordoc', 'mcp'] });
        mcpClient = new Client({ name: 'kordoc-web-app', version: '1.0.0' }, { capabilities: {} });
        await mcpClient.connect(transport);
        log('kordoc MCP 서버 연결 성공');

        // 1) 수정대상 파싱 -> target_parsed.md 저장
        targetParsed = await robustParse(mcpClient, targetFile.path, targetDisplayName);

        // 2) 비교대상 파싱 -> compare_parsed_*.md 저장
        for (let i = 0; i < compareFiles.length; i++) {
          const file = compareFiles[i];
          const compareDisplayName = normalizeKoreanFilename(file.originalname);
          const parsed = await robustParse(mcpClient, file.path, compareDisplayName);
          const md = parsed.markdown;
          const mdPath = path.join(__dirname, `compare_parsed_${i + 1}.md`);
          fs.writeFileSync(mdPath, md, 'utf8');
          compareParsed.push({
            fileName: compareDisplayName,
            markdown: md,
            markdownPath: mdPath,
            parser: parsed.parser,
            detect: parsed.detect,
            metadata: parsed.metadata,
          });
        }
      } else if (analysisMode === 'ai_direct') {
        log('AI분석(직접비교) 모드 시작: kordoc 파싱 없이 PDF 직접 추출');
        targetParsed = await directParseWithoutKordoc(targetFile.path, targetDisplayName);

        for (let i = 0; i < compareFiles.length; i++) {
          const file = compareFiles[i];
          const compareDisplayName = normalizeKoreanFilename(file.originalname);
          const parsed = await directParseWithoutKordoc(file.path, compareDisplayName);
          const md = parsed.markdown;
          const mdPath = path.join(__dirname, `compare_parsed_${i + 1}.md`);
          fs.writeFileSync(mdPath, md, 'utf8');
          compareParsed.push({
            fileName: compareDisplayName,
            markdown: md,
            markdownPath: mdPath,
            parser: parsed.parser,
            detect: parsed.detect,
            metadata: parsed.metadata,
          });
        }
      } else {
        throw new Error(`지원하지 않는 분석 모드: ${analysisMode}`);
      }

      const targetMarkdown = targetParsed.markdown;
      const targetMdPath = path.join(__dirname, 'target_parsed.md');
      fs.writeFileSync(targetMdPath, targetMarkdown, 'utf8');

      // 비교 파일이 1개면 호환용 compare_parsed.md도 생성
      if (compareParsed.length === 1) {
        fs.writeFileSync(path.join(__dirname, 'compare_parsed.md'), compareParsed[0].markdown, 'utf8');
      }

      // 3) parsed_text.json 저장
      const parsedPayload = {
        stage: '1-문서 파싱 및 마크다운 변환',
        analysisMode,
        target: {
          fileName: targetFile.originalname,
          displayName: targetDisplayName,
          parser: targetParsed.parser,
          detect: targetParsed.detect,
          metadata: targetParsed.metadata,
          markdownPath: targetMdPath,
          markdown: targetMarkdown,
        },
        compare: compareParsed.map((c) => ({
          fileName: c.fileName,
          parser: c.parser,
          detect: c.detect,
          metadata: c.metadata,
          markdownPath: c.markdownPath,
          markdown: c.markdown,
        })),
      };
      fs.writeFileSync(path.join(__dirname, 'parsed_text.json'), JSON.stringify(parsedPayload, null, 2), 'utf8');

      // 3-1) 파싱 감사 리포트 저장
      const auditPayload = buildParseAudit(targetMarkdown, compareParsed);
      fs.writeFileSync(path.join(__dirname, 'parse_audit.json'), JSON.stringify(auditPayload, null, 2), 'utf8');

      // 4) 수정대상 사업목록 추출(하단 표 기준 데이터)
      let targetRows = extractTargetBusinessRows(targetMarkdown);
      if (targetRows.length <= 1) {
        const aiExtractedRows = await extractTargetRowsWithAI({
          targetMarkdown,
          apiKeyOverride,
          modelIdOverride,
        }).catch(() => []);
        if (aiExtractedRows.length > targetRows.length) {
          targetRows = aiExtractedRows;
        }
      }

      // 동일 입력에 대한 결과 변동 방지: 파일 내용 해시 기반 캐시
      const resolvedModelId = modelIdOverride || 'openai/gpt-5.3-chat';
      const compareConcat = compareParsed.map((c) => c.markdown || '').join('\n\n---\n\n');
      const cacheKey = sha256(JSON.stringify({
        v: 'revision-v3',
        analysisMode,
        modelId: resolvedModelId,
        targetMarkdown,
        compareConcat,
      }));

      if (analysisCache[cacheKey]) {
        const cached = analysisCache[cacheKey];
        const cachedRevision = Array.isArray(cached?.revisionList) ? cached.revisionList : [];
        const cachedLegacy = Array.isArray(cached?.legacyResults) ? cached.legacyResults : [];

        const analysisPayload = {
          analysis: { results: cachedRevision },
          revisionList: cachedRevision,
          legacyResults: cachedLegacy,
          targetRowsCount: targetRows.length,
          targetBusinessRows: targetRows,
          cacheHit: true,
        };

        fs.writeFileSync(path.join(__dirname, 'analysis_result.json'), JSON.stringify(analysisPayload, null, 2), 'utf8');
        const savedExcelPath = saveExcel(cachedRevision);

        return res.json({
          success: true,
          data: {
            ...analysisPayload,
            targetMarkdown,
            paging: {
              pageSize: 20,
              totalRows: cachedRevision.length,
              totalPages: Math.max(1, Math.ceil(cachedRevision.length / 20)),
            },
            excelPath: savedExcelPath,
          },
        });
      }

      // 5) AI 비교 분석
      // - targetRows가 충분하면 행 단위로 수정컬럼을 채운다(노트북LM 유사 동작)
      // - targetRows가 비어 있으면 기존 전체분석 방식으로 폴백
      let mergedResults = [];
      if (targetRows.length > 0) {
        const compareAllMarkdown = compareParsed.map((c) => c.markdown || '').join('\n\n');
        mergedResults = [];
        for (const base of targetRows) {
          let best = {
            대상수정내용: '',
            내용수정내용: '',
            방법수정내용: '',
            문의수정내용: '',
            사업담당자: '',
          };

          // 비교대상이 여러 개인 경우, 가장 정보가 많이 채워진 결과를 선택
          for (const c of compareParsed) {
            const candidate = await analyzeSingleRowWithAI({
              baseRow: base,
              compareMarkdown: c.markdown,
              compareFileName: c.fileName,
              apiKeyOverride,
              modelIdOverride,
            });
            if (filledUpdateScore(candidate) > filledUpdateScore(best)) {
              best = candidate;
            }
          }

          // compareParsed가 1개도 없는 비정상 상황 방어
          if (compareParsed.length === 0) {
            const candidate = await analyzeSingleRowWithAI({
              baseRow: base,
              compareMarkdown: compareAllMarkdown,
              compareFileName: 'compare',
              apiKeyOverride,
              modelIdOverride,
            });
            if (filledUpdateScore(candidate) > filledUpdateScore(best)) best = candidate;
          }

          mergedResults.push({
            페이지번호: toText(base.페이지번호),
            사업명: toText(base.사업명),
            대상: toText(base.대상),
            내용: toText(base.내용),
            방법: toText(base.방법),
            문의: toText(base.문의),
            대상수정내용: toText(best.대상수정내용),
            내용수정내용: toText(best.내용수정내용),
            방법수정내용: toText(best.방법수정내용),
            문의수정내용: toText(best.문의수정내용),
            사업담당자: toText(best.사업담당자 || base.사업담당자),
          });
        }
      } else {
        let allResults = [];
        for (const c of compareParsed) {
          const results = await analyzeWithAI({
            targetMarkdown,
            compareMarkdown: c.markdown,
            compareFileName: c.fileName,
            targetRows,
            apiKeyOverride,
            modelIdOverride,
          });
          allResults = allResults.concat(results);
        }
        mergedResults = mergeByTargetBaseRows(targetRows, allResults);
      }

      // 6) 최종 수정목록(요청 형식: 서비스명/변경항목/기존내용/변경내용/변경사유)
      let revisionList = [];
      for (const c of compareParsed) {
        const rows = await buildRevisionListWithAI({
          targetMarkdown,
          compareMarkdown: c.markdown,
          compareFileName: c.fileName,
          apiKeyOverride,
          modelIdOverride,
        }).catch(() => []);
        revisionList = revisionList.concat(rows);
      }
      if (revisionList.length === 0) {
        revisionList = buildRevisionListFallback(mergedResults);
      }

      const dedupedRevision = [];
      const seenRevision = new Set();
      for (const r of revisionList) {
        const k = `${normalizeDedupText(r.서비스명)}__${normalizeDedupText(r.변경항목)}__${normalizeDedupText(r.변경내용)}`;
        if (!toText(r.서비스명) || !toText(r.변경항목) || !toText(r.변경내용)) continue;
        if (seenRevision.has(k)) continue;
        seenRevision.add(k);
        dedupedRevision.push(r);
      }

      analysisCache[cacheKey] = {
        savedAt: new Date().toISOString(),
        revisionList: dedupedRevision,
        legacyResults: mergedResults,
      };
      writeAnalysisCache();

      // 7) analysis_result.json + 엑셀 저장
      const analysisPayload = {
        analysis: { results: dedupedRevision },
        revisionList: dedupedRevision,
        legacyResults: mergedResults,
        targetRowsCount: targetRows.length,
        targetBusinessRows: targetRows,
      };
      fs.writeFileSync(path.join(__dirname, 'analysis_result.json'), JSON.stringify(analysisPayload, null, 2), 'utf8');
      const savedExcelPath = saveExcel(dedupedRevision);

      res.json({
        success: true,
        data: {
          ...analysisPayload,
          targetMarkdown,
          paging: {
            pageSize: 20,
            totalRows: dedupedRevision.length,
            totalPages: Math.max(1, Math.ceil(dedupedRevision.length / 20)),
          },
          excelPath: savedExcelPath,
        },
      });
    } catch (err) {
      log(`오류: ${err.message}`);
      res.status(500).json({ success: false, message: err.message });
    } finally {
      if (mcpClient) {
        try { await mcpClient.close(); } catch (_) {}
      }
    }
  }
);

app.listen(PORT, () => {
  log(`서버 실행: http://localhost:${PORT}`);
});
