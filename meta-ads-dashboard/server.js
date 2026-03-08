require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const META_API_VERSION = 'v21.0';
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

// ── helpers ──────────────────────────────────────────────────────────────────

function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

const AD_METRICS = [
  'impressions', 'clicks', 'spend', 'reach',
  'ctr', 'cpc', 'cpm', 'cpp',
  'actions', 'cost_per_action_type',
  'purchase_roas', 'frequency',
  'unique_clicks', 'unique_ctr',
].join(',');

// ── Meta Ads routes ───────────────────────────────────────────────────────────

// GET /api/config  – returns whether env vars are present (never returns secrets)
app.get('/api/config', (req, res) => {
  res.json({
    hasMetaToken:    !!process.env.META_ACCESS_TOKEN,
    hasAdAccountId:  !!process.env.META_AD_ACCOUNT_ID,
    hasClaudeKey:    !!process.env.ANTHROPIC_API_KEY,
    hasManusKey:     !!process.env.MANUS_API_KEY,
  });
});

// GET /api/ads?days=7
// Returns ad-level metrics for [today-days .. today] and [today-2*days .. today-days]
app.get('/api/ads', async (req, res) => {
  const token     = req.headers['x-meta-token']     || process.env.META_ACCESS_TOKEN;
  const accountId = req.headers['x-meta-account-id'] || process.env.META_AD_ACCOUNT_ID;
  const days      = parseInt(req.query.days || '7', 10);

  if (!token || !accountId) {
    return res.status(400).json({ error: 'Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID' });
  }

  const current = { since: dateStr(days),     until: dateStr(0) };
  const prev    = { since: dateStr(days * 2),  until: dateStr(days + 1) };

  try {
    const [currRes, prevRes] = await Promise.all([
      axios.get(`${META_BASE_URL}/act_${accountId}/insights`, {
        params: {
          access_token: token,
          level: 'ad',
          fields: `ad_id,ad_name,${AD_METRICS}`,
          time_range: JSON.stringify(current),
          limit: 500,
        },
      }),
      axios.get(`${META_BASE_URL}/act_${accountId}/insights`, {
        params: {
          access_token: token,
          level: 'ad',
          fields: `ad_id,ad_name,${AD_METRICS}`,
          time_range: JSON.stringify(prev),
          limit: 500,
        },
      }),
    ]);

    res.json({
      current: currRes.data.data || [],
      previous: prevRes.data.data || [],
      period: { current, previous: prev },
    });
  } catch (err) {
    const detail = err.response?.data || err.message;
    res.status(500).json({ error: 'Meta API error', detail });
  }
});

// GET /api/creatives?days=7
app.get('/api/creatives', async (req, res) => {
  const token     = req.headers['x-meta-token']     || process.env.META_ACCESS_TOKEN;
  const accountId = req.headers['x-meta-account-id'] || process.env.META_AD_ACCOUNT_ID;
  const days      = parseInt(req.query.days || '7', 10);

  if (!token || !accountId) {
    return res.status(400).json({ error: 'Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID' });
  }

  const current = { since: dateStr(days),     until: dateStr(0) };
  const prev    = { since: dateStr(days * 2),  until: dateStr(days + 1) };

  try {
    const [currRes, prevRes] = await Promise.all([
      axios.get(`${META_BASE_URL}/act_${accountId}/insights`, {
        params: {
          access_token: token,
          level: 'ad',
          fields: `creative{id,name,thumbnail_url},${AD_METRICS}`,
          time_range: JSON.stringify(current),
          limit: 500,
        },
      }),
      axios.get(`${META_BASE_URL}/act_${accountId}/insights`, {
        params: {
          access_token: token,
          level: 'ad',
          fields: `creative{id,name,thumbnail_url},${AD_METRICS}`,
          time_range: JSON.stringify(prev),
          limit: 500,
        },
      }),
    ]);

    // group by creative id
    function groupByCreative(rows) {
      const map = {};
      for (const row of rows) {
        const creativeId   = row.creative?.id   || 'unknown';
        const creativeName = row.creative?.name  || creativeId;
        const thumb        = row.creative?.thumbnail_url || null;
        if (!map[creativeId]) {
          map[creativeId] = { creative_id: creativeId, creative_name: creativeName, thumbnail_url: thumb, _rows: [] };
        }
        map[creativeId]._rows.push(row);
      }
      // aggregate numeric fields across rows for same creative
      const numFields = ['impressions','clicks','spend','reach','unique_clicks','frequency'];
      return Object.values(map).map(entry => {
        const agg = { ...entry };
        delete agg._rows;
        for (const f of numFields) {
          agg[f] = entry._rows.reduce((s, r) => s + parseFloat(r[f] || 0), 0);
        }
        // derived
        agg.ctr  = agg.impressions ? (agg.clicks / agg.impressions * 100).toFixed(2) : '0';
        agg.cpc  = agg.clicks      ? (agg.spend  / agg.clicks).toFixed(2)            : '0';
        agg.cpm  = agg.impressions ? (agg.spend  / agg.impressions * 1000).toFixed(2): '0';

        // merge purchase_roas from first row that has it
        const roasRow = entry._rows.find(r => r.purchase_roas);
        agg.purchase_roas = roasRow?.purchase_roas || null;

        return agg;
      });
    }

    res.json({
      current:  groupByCreative(currRes.data.data || []),
      previous: groupByCreative(prevRes.data.data || []),
      period: { current, previous: prev },
    });
  } catch (err) {
    const detail = err.response?.data || err.message;
    res.status(500).json({ error: 'Meta API error', detail });
  }
});

// ── AI Chat route ─────────────────────────────────────────────────────────────

// POST /api/chat
// body: { model: 'claude'|'manus', messages: [...], context: { ads, creatives } }
app.post('/api/chat', async (req, res) => {
  const { model = 'claude', messages = [], context = {} } = req.body;

  // Build a system prompt that injects the data context
  const systemPrompt = buildSystemPrompt(context);

  if (model === 'claude') {
    const apiKey = req.headers['x-claude-key'] || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'Missing ANTHROPIC_API_KEY' });

    const client = new Anthropic({ apiKey });

    // Stream the response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      const stream = await client.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: systemPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
      });

      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }

  } else if (model === 'manus') {
    // Manus does not yet publish a stable public API.
    // When Manus releases their API, replace this block with the real HTTP call.
    const apiKey = req.headers['x-manus-key'] || process.env.MANUS_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'Missing MANUS_API_KEY' });

    // Placeholder – swap for actual Manus endpoint when available
    return res.status(501).json({
      error: 'Manus API integration coming soon',
      hint: 'Replace this stub in server.js with the Manus HTTP call once their public API is available.',
    });

  } else {
    return res.status(400).json({ error: `Unknown model: ${model}` });
  }
});

// ── helpers ───────────────────────────────────────────────────────────────────

function buildSystemPrompt(context) {
  let prompt = `Bạn là chuyên gia phân tích quảng cáo Meta Ads (Facebook/Instagram).
Nhiệm vụ: phân tích dữ liệu hiệu suất quảng cáo và đưa ra insights hữu ích, actionable.

Hãy:
- Chỉ ra các ad / creative đang hoạt động tốt hoặc kém so với kỳ trước
- Gợi ý nguyên nhân và hành động cụ thể
- Trả lời bằng tiếng Việt trừ khi được yêu cầu khác
- Sử dụng số liệu cụ thể khi phân tích

`;

  if (context.ads?.current?.length) {
    prompt += `\n## Dữ liệu ADs hiện tại (${context.period?.current?.since || ''} → ${context.period?.current?.until || ''}):\n`;
    prompt += JSON.stringify(context.ads.current.slice(0, 50), null, 2);
  }
  if (context.ads?.previous?.length) {
    prompt += `\n## Dữ liệu ADs kỳ trước (${context.period?.previous?.since || ''} → ${context.period?.previous?.until || ''}):\n`;
    prompt += JSON.stringify(context.ads.previous.slice(0, 50), null, 2);
  }
  if (context.creatives?.current?.length) {
    prompt += `\n## Dữ liệu Creatives hiện tại:\n`;
    prompt += JSON.stringify(context.creatives.current.slice(0, 30), null, 2);
  }
  if (context.creatives?.previous?.length) {
    prompt += `\n## Dữ liệu Creatives kỳ trước:\n`;
    prompt += JSON.stringify(context.creatives.previous.slice(0, 30), null, 2);
  }

  return prompt;
}

// ── start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Meta Ads Dashboard server running on http://localhost:${PORT}`);
});
