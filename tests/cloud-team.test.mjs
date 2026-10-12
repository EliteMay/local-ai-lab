import test from 'node:test';
import assert from 'node:assert/strict';
import { runTeam, createMockAsk, validateTeamOptions } from '../src/cloud-team/team.mjs';
import { createCloudAsk } from '../src/cloud-team/providers.mjs';

test('模擬AIの自由会話を1周して9回以上に暴走しない', async () => {
  const output = await runTeam({ topic: 'テストテーマ', rounds: 1, ask: createMockAsk() });
  assert.equal(output.status, 'completed');
  assert.equal(output.calls, 3);
  assert.deepEqual(output.transcript.map(t => t.role), ['planner', 'reviewer', 'integrator']);
  assert.match(output.summary, /模擬応答/);
});

test('開発モードでもファイルやコマンドの実行機能を提供しない', async () => {
  const calls = [];
  const result = await runTeam({ topic: 'GitHubレビュー', mode: 'dev', rounds: 2,
    ask: async (request) => { calls.push(request); return '提案だけ'; } });
  assert.equal(result.calls, 6);
  assert.match(calls[0].system, /実装済みとは言わない/);
  assert.match(calls[1].prompt, /提案だけ/);
  assert.ok(calls.every(({ prompt }) => prompt.length < 11000));
});

test('入力・最大周回数を検証する', () => {
  assert.throws(() => validateTeamOptions({ topic: '', rounds: 1 }));
  assert.throws(() => validateTeamOptions({ topic: 'a', rounds: 4 }));
  assert.throws(() => validateTeamOptions({ topic: 'a', rounds: 0 }));
  assert.throws(() => validateTeamOptions({ topic: 'a', mode: 'shell' }));
});

test('不正応答時に停止して無限リトライしない', async () => {
  let calls = 0;
  await assert.rejects(runTeam({ topic: 'テーマ', rounds: 2, ask: async () => { calls++; return ''; } }), /応答/);
  assert.equal(calls, 1);
});

test('無料枠確認なし・非free OpenRouterモデル・Gemini非許可モデルを拒否', () => {
  assert.throws(() => createCloudAsk({ provider: 'gemini', model: 'gemini-2.5-flash-lite', env: {} }), /無料枠/);
  assert.throws(() => createCloudAsk({ provider: 'gemini', model: 'gemini-3.1-pro', env: { CLOUD_TEAM_FREE_TIER_CONFIRMED: '1' } }), /モデル/);
  assert.throws(() => createCloudAsk({ provider: 'openrouter', model: 'openai/gpt-4o', env: { CLOUD_TEAM_FREE_TIER_CONFIRMED: '1' } }), /free/);
});

test('GeminiのAPIは固定HTTPSにのみ送信し、トークンはヘッダのみ', async () => {
  let request;
  const ask = createCloudAsk({ provider: 'gemini', model: 'gemini-2.5-flash-lite',
    env: { CLOUD_TEAM_FREE_TIER_CONFIRMED: '1', GEMINI_API_KEY: 'private-token' },
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }) }; } });
  assert.equal(await ask({ system: 's', prompt: 'p' }), 'OK');
  assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent');
  assert.equal(request.options.headers['x-goog-api-key'], 'private-token');
  assert.ok(!request.url.includes('private-token'));
});

test('OpenRouter 429で停止して自動有料切替しない', async () => {
  let attempts = 0;
  const ask = createCloudAsk({ provider: 'openrouter', model: 'vendor/model:free',
    env: { CLOUD_TEAM_FREE_TIER_CONFIRMED: '1', OPENROUTER_API_KEY: 'private-token' },
    fetchImpl: async () => { attempts++; return { ok: false, status: 429 }; } });
  await assert.rejects(ask({ system: 's', prompt: 'p' }), /429/);
  assert.equal(attempts, 1);
});

test('異常な長文応答を拒否する', async () => {
  await assert.rejects(runTeam({ topic: 'x', ask: async () => 'a'.repeat(4001) }), /長すぎ/);
});
