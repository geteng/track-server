/* ============================================================
   AI 对话分析接口（DeepSeek 官方接口的服务端包装）
   - 免登录：不挂 partnerAuth.requireAuth，可直接调用
   - 对外只暴露 /api/ai/chat 与 /api/ai/config
   - API Key 保存在服务端，前端永远拿不到
   详见 doc/AI对话分析接口文档.md
   ============================================================ */
const express = require('express');

const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'sk-0152e5136946463eaa6798e9d30ab790';
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 120000);
/* 单次请求内容长度上限，避免超长聊天记录把额度打爆 */
const MAX_CHARS = Number(process.env.DEEPSEEK_MAX_CHARS || 20000);

const DEFAULT_SYSTEM = '你是严谨的 B 端客户对话分析助手，只依据对话原文分析，输出纯 JSON。';

const toText = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/* 从模型输出里剥出 JSON：兼容 ```json 代码块、前后多余说明文字 */
function extractJson(text) {
  const raw = toText(text).trim();
  if (!raw) return null;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const cleaned = (fence ? fence[1] : raw).trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

/* 提示词 + 聊天内容拼接：提示词结尾非换行时自动补一个换行 */
function joinPrompt(prompt, content) {
  const p = toText(prompt);
  const c = toText(content);
  if (!p) return c;
  if (!c) return p;
  return /\n\s*$/.test(p) ? p + c : p + '\n' + c;
}

async function callDeepSeek({ model, messages, temperature, maxTokens, jsonMode, timeoutMs }) {
  const payload = {
    model,
    messages,
    stream: false,
    temperature,
    max_tokens: maxTokens,
  };
  if (jsonMode) payload.response_format = { type: 'json_object' };

  const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = null;
  }

  if (!resp.ok) {
    const msg = (json && (json.error && (json.error.message || json.error.code))) || text.slice(0, 500) || `HTTP ${resp.status}`;
    const err = new Error(`DeepSeek 返回 ${resp.status}：${msg}`);
    err.status = resp.status;
    err.upstream = json || text.slice(0, 500);
    throw err;
  }

  const choice = (json && json.choices && json.choices[0]) || {};
  const content = (choice.message && choice.message.content) || '';
  return {
    model: (json && json.model) || model,
    content,
    finishReason: choice.finish_reason || '',
    usage: (json && json.usage) || null,
  };
}

module.exports = function createAiApi() {
  const router = express.Router();

  /* 接口自检：确认模型与 Key 是否已配置（不返回 Key 明文） */
  router.get('/config', (req, res) => {
    res.json({
      code: 0,
      msg: 'ok',
      data: {
        provider: 'deepseek',
        model: DEFAULT_MODEL,
        hasKey: !!DEEPSEEK_API_KEY,
        maxChars: MAX_CHARS,
        needLogin: false,
      },
    });
  });

  /* ============================================================
     POST /api/ai/chat · 按提示词分析聊天记录（免登录）
     body: { prompt, content, model?, temperature?, max_tokens?, system?, json_mode? }
     ============================================================ */
  router.post('/chat', async (req, res) => {
    const body = req.body || {};
    const prompt = toText(body.prompt);
    const content = toText(body.content != null ? body.content : body.chat);

    if (!content.trim()) {
      return res.status(400).json({ code: 400, msg: 'content 不能为空（客户聊天内容）', data: null });
    }

    const finalPrompt = joinPrompt(prompt, content);
    if (finalPrompt.length > MAX_CHARS) {
      return res.status(413).json({
        code: 413,
        msg: `内容过长：${finalPrompt.length} 字符，上限 ${MAX_CHARS}`,
        data: null,
      });
    }

    const model = toText(body.model) || DEFAULT_MODEL;
    const temperature = Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0;
    const maxTokens = Number.isFinite(Number(body.max_tokens)) ? Number(body.max_tokens) : 2000;
    const jsonMode = body.json_mode === false ? false : true;
    const messages = [
      { role: 'system', content: toText(body.system) || DEFAULT_SYSTEM },
      { role: 'user', content: finalPrompt },
    ];

    try {
      let result;
      try {
        result = await callDeepSeek({ model, messages, temperature, maxTokens, jsonMode, timeoutMs: DEFAULT_TIMEOUT_MS });
      } catch (err) {
        // json_object 模式要求提示词里出现 JSON 字样，自定义提示词不满足时自动降级重试一次
        if (jsonMode && err && err.status === 400) {
          result = await callDeepSeek({ model, messages, temperature, maxTokens, jsonMode: false, timeoutMs: DEFAULT_TIMEOUT_MS });
        } else {
          throw err;
        }
      }

      res.json({
        code: 0,
        msg: 'ok',
        data: {
          model: result.model,
          content: result.content,
          json: extractJson(result.content),
          finish_reason: result.finishReason,
          usage: result.usage,
          prompt_chars: finalPrompt.length,
        },
      });
    } catch (err) {
      const aborted = err && err.name === 'TimeoutError';
      console.error('[ai-api] DeepSeek 调用失败:', err && err.message);
      res.status(aborted ? 504 : 502).json({
        code: aborted ? 504 : 502,
        msg: aborted ? 'DeepSeek 请求超时，请稍后重试' : `DeepSeek 调用失败：${err && err.message}`,
        data: null,
      });
    }
  });

  return router;
};
