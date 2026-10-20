const GEMINI_FREE_CANDIDATES = new Set(['gemini-2.5-flash-lite', 'gemini-3.1-flash-lite']);
const DEFAULT_TIMEOUT_MS = 30000;

async function requestJson(url, headers, payload, fetchImpl, signal) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new Error('AI APIへの通信に失敗しました（回線またはタイムアウト）');
  }
  if (!response.ok) {
    if (response.status === 429) throw new Error('無料枠・レート制限に達しました (429)。追加課金せず停止します');
    throw new Error('AI APIがHTTP ' + response.status + 'を返しました。自動で再試行しません');
  }
  try {
    return await response.json();
  } catch {
    throw new Error('AI APIのJSON応答を読み取れません');
  }
}

export function createCloudAsk({ provider, model, env = process.env, fetchImpl = fetch } = {}) {
  if (provider === 'mock') {
    throw new Error('mock利用時はcreateMockAskを使ってください');
  }
  // Geminiの無料対象モデルでも、請求設定済みProjectなら課金され得る。
  // 料金設定確認を明示しない場合、実API呼出しは許可しない。
  if (env.CLOUD_TEAM_FREE_TIER_CONFIRMED !== '1') {
    throw new Error('無料枠のAPIキー・請求設定を確認し、CLOUD_TEAM_FREE_TIER_CONFIRMED=1を設定してください');
  }
  if (provider === 'gemini') {
    if (!GEMINI_FREE_CANDIDATES.has(model)) throw new Error('許可されたGemini無料枠候補モデルではありません');
    const key = env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEYが必要です');
    return async ({ system, prompt, signal }) => {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
      const data = await requestJson(url, { 'x-goog-api-key': key }, {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 700 },
      }, fetchImpl, signal);
      return (data.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('').trim();
    };
  }
  if (provider === 'openrouter') {
    if (typeof model !== 'string' || !/^[a-z0-9._-]+\/[a-z0-9._-]+:free$/.test(model)) {
      throw new Error('OpenRouterはprovider/model:free形式のみ許可します');
    }
    const key = env.OPENROUTER_API_KEY;
    if (!key) throw new Error('OPENROUTER_API_KEYが必要です');
    return async ({ system, prompt, signal }) => {
      const data = await requestJson('https://openrouter.ai/api/v1/chat/completions',
        { authorization: 'Bearer ' + key },
        { model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_tokens: 700 },
        fetchImpl, signal);
      return data.choices?.[0]?.message?.content;
    };
  }
  throw new Error('不明なproviderです');
}
