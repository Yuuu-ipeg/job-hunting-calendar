const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001;
const DATA_FILE = path.join(__dirname, 'events.json');

// ─── AI設定（優先順: Gemini無料 → Anthropic） ────────────────────────────────
const GEMINI_KEY     = process.env.GEMINI_API_KEY     || '';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY  || '';

let geminiModel = null;
if (GEMINI_KEY) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(GEMINI_KEY);
  geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
}

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

// ─── Data helpers ────────────────────────────────────────────────────────────
function loadEvents() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}
function saveEvents(events) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(events, null, 2), 'utf8');
}
function nextId(events) {
  return events.length > 0 ? Math.max(...events.map(e => e.id)) + 1 : 1;
}

// ─── Events CRUD ─────────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => res.json(loadEvents()));

app.post('/api/events', (req, res) => {
  const events = loadEvents();
  const ev = { ...req.body, id: nextId(events), createdAt: new Date().toISOString() };
  events.push(ev);
  saveEvents(events);
  res.json(ev);
});

app.put('/api/events/:id', (req, res) => {
  let events = loadEvents();
  const idx = events.findIndex(e => e.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  events[idx] = { ...events[idx], ...req.body, id: events[idx].id };
  saveEvents(events);
  res.json(events[idx]);
});

app.delete('/api/events/:id', (req, res) => {
  let events = loadEvents().filter(e => e.id !== parseInt(req.params.id));
  saveEvents(events);
  res.json({ ok: true });
});

app.post('/api/import', (req, res) => {
  const { events } = req.body;
  if (!Array.isArray(events)) return res.status(400).json({ error: 'events array required' });
  saveEvents(events);
  res.json({ ok: true, count: events.length });
});

// ─── AI プロンプト共通 ────────────────────────────────────────────────────────
function buildPrompt(extraContext = '') {
  const today = new Date().toISOString().split('T')[0];
  return `あなたは日本の就職活動支援AIです。
ユーザーが貼り付けたテキストや画像を分析し、就活イベント情報（インターン・説明会・締切など）を抽出してください。
今日の日付: ${today}
${extraContext}

以下のJSON形式のみで回答（複数イベントは配列）:
[
  {
    "date": "YYYY-MM-DD",
    "company": "会社名",
    "desc": "内容の簡潔な説明（30字以内）",
    "detail": "詳細（SNS内容を要約）",
    "cat": "consult|shosha|it|finance|other",
    "status": "entry|pre_entry|selection|result|seminar|deadline|intern",
    "url": "URLがあれば（なければ空文字）",
    "icon": "適切な絵文字"
  }
]

カテゴリ基準:
- consult: コンサル・監査法人・BCG・マッキンゼー・デロイト・PwC・アクセンチュアなど
- shosha: 商社・三菱商事・三井物産・伊藤忠・住友・丸紅など
- it: IT・テック・Google・Meta・Amazon・LINE・楽天・サイバーエージェントなど
- finance: 銀行・証券・保険・投資・野村・三菱UFJなど
- other: その他

就活情報がなければ[]を返す。JSON以外の文章は不要。`;
}

// ─── Gemini で解析 ────────────────────────────────────────────────────────────
async function analyzeWithGemini(text, imageBase64, imageMediaType) {
  const prompt = buildPrompt();
  const parts = [];
  if (imageBase64) {
    parts.push({ inlineData: { mimeType: imageMediaType || 'image/jpeg', data: imageBase64 } });
  }
  parts.push({ text: prompt + '\n\n入力:\n' + (text || '上記の画像から就活情報を抽出してください。') });
  const result = await geminiModel.generateContent(parts);
  return result.response.text().trim();
}

// ─── Anthropic で解析（フォールバック） ──────────────────────────────────────
async function analyzeWithAnthropic(text, imageBase64, imageMediaType) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const userContent = [];
  if (imageBase64) {
    userContent.push({ type: 'image', source: { type: 'base64', media_type: imageMediaType || 'image/jpeg', data: imageBase64 } });
  }
  userContent.push({ type: 'text', text: text || '上記の画像から就活情報を抽出してください。' });
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2048,
    system: buildPrompt(),
    messages: [{ role: 'user', content: userContent }]
  });
  const block = response.content.find(b => b.type === 'text');
  return block ? block.text.trim() : '[]';
}

// ─── /api/analyze ─────────────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { text, imageBase64, imageMediaType } = req.body;
  if (!text && !imageBase64) return res.status(400).json({ error: 'text or image required' });

  if (!geminiModel && !ANTHROPIC_KEY) {
    return res.status(500).json({
      error: 'AIのAPIキーが設定されていません。\n\nGemini無料キーを取得: https://aistudio.google.com/app/apikey\n取得後: GEMINI_API_KEY=<キー> node server.js'
    });
  }

  try {
    let raw;
    if (geminiModel) {
      raw = await analyzeWithGemini(text, imageBase64, imageMediaType);
    } else {
      raw = await analyzeWithAnthropic(text, imageBase64, imageMediaType);
    }

    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    if (parsed.length > 0) {
      const events = loadEvents();
      let maxId = events.length > 0 ? Math.max(...events.map(e => e.id)) : 0;
      const newEvents = parsed.map((ev, i) => ({
        ...ev, id: maxId + i + 1, acc: 'sns', createdAt: new Date().toISOString(), source: 'ai'
      }));
      events.push(...newEvents);
      saveEvents(events);
    }

    res.json({ events: parsed });
  } catch (err) {
    console.error('AI API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/parse-email ────────────────────────────────────────────────────────
app.post('/api/parse-email', async (req, res) => {
  const { subject, body, sender, date } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });
  if (!geminiModel && !ANTHROPIC_KEY) return res.status(500).json({ error: 'AIキー未設定' });

  const emailPrompt = buildPrompt(`
対象: メール本文
出力形式はオブジェクト{}（配列でなく）:
{
  "company": "...", "date": "YYYY-MM-DD", "desc": "...", "detail": "...",
  "cat": "...", "status": "...", "url": "...", "icon": "...", "isJobRelated": true|false
}`);

  const inputText = `件名: ${subject || ''}\n送信者: ${sender || ''}\n受信日: ${date || ''}\n\n本文:\n${body}`;

  try {
    let raw;
    if (geminiModel) {
      const result = await geminiModel.generateContent(emailPrompt + '\n\n' + inputText);
      raw = result.response.text().trim();
    } else {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
      const response = await client.messages.create({
        model: 'claude-opus-4-6', max_tokens: 1024, system: emailPrompt,
        messages: [{ role: 'user', content: inputText }]
      });
      raw = (response.content.find(b => b.type === 'text') || {}).text || '{}';
    }

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    if (parsed.isJobRelated && parsed.company) {
      const events = loadEvents();
      const ev = {
        ...parsed, id: nextId(events), acc: 'email', source: 'email',
        emailSubject: subject || '', emailSender: sender || '', createdAt: new Date().toISOString()
      };
      delete ev.isJobRelated;
      events.push(ev);
      saveEvents(events);
      res.json({ saved: true, event: ev });
    } else {
      res.json({ saved: false, parsed });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const ai = geminiModel ? 'gemini' : ANTHROPIC_KEY ? 'anthropic' : 'none';
  res.json({ ok: true, ai, hasApiKey: !!(geminiModel || ANTHROPIC_KEY), events: loadEvents().length });
});

app.listen(PORT, () => {
  const ai = geminiModel ? '✅ Gemini 1.5 Flash (無料)' : ANTHROPIC_KEY ? '✅ Anthropic Claude' : '❌ 未設定';
  console.log(`\n✅ Job Hunting Calendar Server  →  http://localhost:${PORT}`);
  console.log(`   AI エンジン : ${ai}`);
  if (!geminiModel && !ANTHROPIC_KEY) {
    console.log(`\n   ⚠️  Gemini無料キーを取得してください:`);
    console.log(`      https://aistudio.google.com/app/apikey`);
    console.log(`      起動: GEMINI_API_KEY=<キー> node server.js\n`);
  }
  console.log(`   データ: ${DATA_FILE}\n`);
});
