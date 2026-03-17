const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = 3001;
const DATA_FILE = path.join(__dirname, 'events.json');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
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
app.get('/api/events', (req, res) => {
  res.json(loadEvents());
});

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
  let events = loadEvents();
  events = events.filter(e => e.id !== parseInt(req.params.id));
  saveEvents(events);
  res.json({ ok: true });
});

// ─── Import seed data ─────────────────────────────────────────────────────────
app.post('/api/import', (req, res) => {
  const { events } = req.body;
  if (!Array.isArray(events)) return res.status(400).json({ error: 'events array required' });
  saveEvents(events);
  res.json({ ok: true, count: events.length });
});

// ─── SNS / テキスト分析 (Claude API) ─────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const { text, imageBase64, imageMediaType } = req.body;
  if (!text && !imageBase64) return res.status(400).json({ error: 'text or image required' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const today = new Date().toISOString().split('T')[0];

  const systemPrompt = `あなたは日本の就職活動支援AIです。
ユーザーがSNS（X/Twitter、Instagram等）から貼り付けたテキストや画像を分析し、
就活イベント情報（インターンシップ、セミナー、説明会、エントリー締切など）を抽出してください。

今日の日付: ${today}

以下のJSON形式で回答してください（複数イベントがある場合は配列）:
[
  {
    "date": "YYYY-MM-DD",
    "company": "会社名",
    "desc": "イベント内容の簡潔な説明（20字以内）",
    "detail": "詳細説明（SNSの内容を要約）",
    "cat": "consult|shosha|it|finance|other",
    "status": "entry|pre_entry|selection|result|seminar|deadline|intern",
    "url": "URLがあれば（なければ空文字）",
    "icon": "適切な絵文字"
  }
]

カテゴリ判定基準:
- consult: コンサル、監査法人、会計、BCG、マッキンゼー、デロイト、PwC、EY、KPMG、アクセンチュアなど
- shosha: 商社、三菱商事、三井物産、伊藤忠、住友商事、丸紅、豊田通商など
- it: IT、テック、ソフトウェア、Google、Meta、Amazon、LINE、Yahoo、楽天など
- finance: 銀行、証券、保険、投資、金融、野村、大和、三菱UFJなど
- other: その他

就活情報が含まれていない場合は空配列[]を返してください。
JSON以外の文章は不要です。`;

  const userContent = [];
  if (imageBase64) {
    userContent.push({
      type: 'image',
      source: { type: 'base64', media_type: imageMediaType || 'image/jpeg', data: imageBase64 }
    });
  }
  userContent.push({ type: 'text', text: text || '上記の画像から就活情報を抽出してください。' });

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      thinking: { type: 'adaptive' },
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }]
    });

    const textBlock = response.content.find(b => b.type === 'text');
    const raw = textBlock ? textBlock.text.trim() : '[]';

    // Extract JSON from response
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    // Auto-save extracted events
    if (parsed.length > 0) {
      const events = loadEvents();
      const newEvents = parsed.map(ev => ({
        ...ev,
        id: nextId(events) + events.length,
        acc: 'sns',
        createdAt: new Date().toISOString(),
        source: 'sns'
      }));
      // Re-assign IDs properly
      let currentMax = events.length > 0 ? Math.max(...events.map(e => e.id)) : 0;
      newEvents.forEach((ev, i) => { ev.id = currentMax + i + 1; });
      events.push(...newEvents);
      saveEvents(events);
    }

    res.json({ events: parsed, raw });
  } catch (err) {
    console.error('Claude API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Email text parser ────────────────────────────────────────────────────────
app.post('/api/parse-email', async (req, res) => {
  const { subject, body, sender, date } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  const systemPrompt = `あなたは日本の就職活動支援AIです。
メール本文を分析し、就活イベント情報を抽出してください。

以下のJSON形式で回答してください:
{
  "company": "会社名",
  "date": "YYYY-MM-DD（締切や開催日、なければ受信日）",
  "desc": "内容の簡潔な説明（20字以内）",
  "detail": "詳細説明",
  "cat": "consult|shosha|it|finance|other",
  "status": "entry|pre_entry|selection|result|seminar|deadline|intern",
  "url": "マイページURLや登録URLがあれば抽出（なければ空文字）",
  "icon": "適切な絵文字",
  "isJobRelated": true|false
}

URLの抽出: メール本文中のhttps://で始まるURLのうち、マイページ・エントリー・登録に関連するものを優先して抽出してください。
就活と無関係なメールはisJobRelated: falseにしてください。
JSON以外の文章は不要です。`;

  try {
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `件名: ${subject || ''}\n送信者: ${sender || ''}\n受信日: ${date || ''}\n\n本文:\n${body}`
      }]
    });

    const textBlock = response.content.find(b => b.type === 'text');
    const raw = textBlock ? textBlock.text.trim() : '{}';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    if (parsed.isJobRelated && parsed.company) {
      const events = loadEvents();
      const ev = {
        ...parsed,
        id: events.length > 0 ? Math.max(...events.map(e => e.id)) + 1 : 1,
        acc: 'email',
        source: 'email',
        emailSubject: subject || '',
        emailSender: sender || '',
        createdAt: new Date().toISOString()
      };
      delete ev.isJobRelated;
      events.push(ev);
      saveEvents(events);
      res.json({ saved: true, event: ev });
    } else {
      res.json({ saved: false, parsed });
    }
  } catch (err) {
    console.error('Claude API error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasApiKey: !!ANTHROPIC_API_KEY, events: loadEvents().length });
});

app.listen(PORT, () => {
  console.log(`\n✅ Job Hunting Calendar Server running at http://localhost:${PORT}`);
  console.log(`   ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY ? '✅ set' : '❌ not set (set env var)'}`);
  console.log(`   Events stored in: ${DATA_FILE}\n`);
});
