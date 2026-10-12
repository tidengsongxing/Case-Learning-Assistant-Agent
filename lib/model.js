'use strict';

/**
 * 大模型调用封装。
 * 采用 OpenAI 兼容的 /chat/completions 协议，可对接任何提供该协议端点的模型服务。
 * 只使用 Node 内置的全局 fetch，不引入任何 SDK。
 */

/* 模型接口地址。默认指向 DeepSeek 的 OpenAI 兼容端点。
   改用其他供应商时，替换为对应的 /chat/completions 地址即可。
   若对方不支持 JSON 输出模式，下面的 response_format 会被忽略，
   系统会自动退回到文本解析与重试的兜底逻辑。 */
const ENDPOINT = 'https://api.deepseek.com/chat/completions';

class ModelError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ModelError';
    this.code = code || 'UNKNOWN';
  }
}

function resolveKey() {
  const key = (process.env.API_KEY || '').trim();
  if (!key || key.includes('在这里填入')) {
    throw new ModelError(
      '还没有配置 API_KEY。请把项目根目录的 .env.example 复制成 .env，填入你的 API Key 后重启服务。',
      'NO_KEY'
    );
  }
  return key;
}

/** 从模型输出里稳健地抽出 JSON 对象 */
function parseJSON(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ModelError('模型返回了空内容', 'EMPTY');
  }

  let s = text.trim();

  // 去掉 ```json ... ``` 代码块包裹
  const fence = s.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();

  try {
    return JSON.parse(s);
  } catch (err) {
    // 兜底：截取第一个 { 到最后一个 } 之间的内容
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch (err2) {
        throw new ModelError('模型返回的内容不是合法 JSON', 'BAD_JSON');
      }
    }
    throw new ModelError('模型返回的内容不是合法 JSON', 'BAD_JSON');
  }
}

/** 发起一次对话补全请求 */
async function chat(options) {
  const apiKey = resolveKey();
  const model = options.model || process.env.MODEL || 'deepseek-chat';
  const timeoutMs = options.timeoutMs || 120000;

  const body = {
    model,
    messages: [
      { role: 'system', content: options.system },
      { role: 'user', content: options.user },
    ],
    temperature: typeof options.temperature === 'number' ? options.temperature : 0.7,
    max_tokens: options.maxTokens || 4000,
    stream: false,
    response_format: { type: 'json_object' },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new ModelError('调用模型接口超时，请稍后重试', 'TIMEOUT');
    }
    throw new ModelError('无法连接模型接口：' + (err && err.message ? err.message : err), 'NETWORK');
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();

  if (!res.ok) {
    let detail = raw;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.error && parsed.error.message) detail = parsed.error.message;
    } catch (err) {
      // 保持原始文本
    }

    if (res.status === 401) {
      throw new ModelError('接口拒绝了这个 API Key（401），请检查 .env 里的 Key 是否正确。', 'AUTH');
    }
    if (res.status === 402) {
      throw new ModelError('账户余额不足（402），请先充值。', 'BALANCE');
    }
    if (res.status === 429) {
      throw new ModelError('请求过于频繁（429），请稍后再试。', 'RATE_LIMIT');
    }
    throw new ModelError('模型接口返回错误 ' + res.status + '：' + String(detail).slice(0, 300), 'HTTP_' + res.status);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new ModelError('无法解析模型接口的响应体', 'BAD_RESPONSE');
  }

  const content =
    payload &&
    payload.choices &&
    payload.choices[0] &&
    payload.choices[0].message &&
    payload.choices[0].message.content;

  if (!content) {
    throw new ModelError('模型接口没有返回内容', 'EMPTY');
  }

  return content;
}

/**
 * 要求模型返回 JSON；如果第一次不是合法 JSON，自动重试一次。
 * 重试时把错误信息一并告知模型，让它自行修正。
 */
async function chatJSON(options) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const user =
      attempt === 0
        ? options.user
        : options.user +
          '\n\n【重要】你上一次的回复不是合法 JSON（' +
          (lastError ? lastError.message : '未知原因') +
          '）。本次必须只输出一个 JSON 对象，不要有任何解释文字，不要使用 Markdown 代码块。';

    const content = await chat({
      system: options.system,
      user,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      model: options.model,
      timeoutMs: options.timeoutMs,
    });

    try {
      return parseJSON(content);
    } catch (err) {
      lastError = err;
    }
  }

  throw new ModelError(
    '模型连续两次都没有返回合法 JSON：' + (lastError ? lastError.message : '未知原因'),
    'BAD_JSON'
  );
}

module.exports = { chat, chatJSON, parseJSON, ModelError };
