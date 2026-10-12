# Cloud AI Team POC（クラウドAI会話・共同開発レビュー）

既存のLocal AI Lab監査・LM Studio・デスクトップ機能とは**別の試験機能**です。Node.js 20以降・外部ライブラリ不要。ローカルLLMは使いません。

## 現在できること

- chat：提案AI → 批判AI → 統合AIで自由会話（1〜3周、最大9発言）
- dev：実装計画 → 安全/品質レビュー → 最小案の統合
- 模擬AIでの無課金動作確認
- Gemini API / OpenRouter無料モデル候補
- 固定HTTPS endpoint・無料モデル候補の制限・失敗時停止・有料APIへの自動切替なし

## 動作確認（APIキー不要）

    node src/cloud-team/cli.mjs --topic "PC Agentの接続方法を議論して" --rounds 2
    node src/cloud-team/cli.mjs --topic "接続エラーの設計をレビュー" --mode dev --rounds 1
    npm test

「[模擬応答]」の場合は**本物のAIではありません**。

## Gemini無料枠利用

1. Google AI Studioで**課金が無効の無料枠プロジェクト**か確認。モデルとクォータ・プライバシー条件も確認。
2. PowerShellセッションでGEMINI_API_KEYとCLOUD_TEAM_FREE_TIER_CONFIRMED=1を環境変数として設定。秘密情報はチャットやGitHubに貼らない。
3. 実行：

    node src/cloud-team/cli.mjs --provider gemini --model gemini-2.5-flash-lite --mode chat --topic "議論したい話題"

## OpenRouter無料モデル利用

1. OpenRouter無料アカウントを利用。現在公開されている末尾:freeのモデルを選ぶ。
2. OPENROUTER_API_KEYとCLOUD_TEAM_FREE_TIER_CONFIRMED=1をPowerShellの環境変数へ設定。
3. 実行（モデル名は実在する無料モデルIDに置換）：

    node src/cloud-team/cli.mjs --provider openrouter --model vendor/model:free --mode dev --topic "レビューする課題"

**費用について重要：** 同じGeminiモデルでも請求設定済みProjectでは料金が発生し得ます。確認フラグは費用ゼロの技術的な保証ではありません。無料プロジェクトの確認は利用者側の責任です。無料枠・モデル提供は変更されることがあります。

API経由で送った議論やコードは外部サービスへ送信されます。秘密情報・非公開コードを含むテーマは入力しないでください。外部プロバイダのデータ利用条件も確認してください。

## 今回のスコープ外

- GitHubコードの読み取り・編集、テスト実行、PR作成
- PC Agentの起動/操作、本番OAuth、Desktop Commander連携
- 無限の議論、無人改修ループ、有料モデルへの切替
- ChatGPT PlusをAPIとして利用すること

共同開発モードは**設計・レビューの対話のみ**。実コードの更新は既存web-project-runtimeの安全なPR・検証・人間承認境界を再利用する別段階。PC Agent Issue #29の完成条件は変更しません。

## 確認用資料

- Gemini料金：https://ai.google.dev/gemini-api/docs/pricing
- Gemini REST：https://ai.google.dev/api/generate-content
- OpenRouter無料枠：https://openrouter.ai/pricing
- OpenRouter chat：https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request
