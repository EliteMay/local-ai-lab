# Local AI Lab

ローカルLLMを使ったAIエージェント、マルチエージェント、RAG、長期記憶、モデル比較、GitHub連携などを研究・実装・評価するための親Repositoryです。

## 最初の目標

最初の主要成果物は **AI Company v1** です。

同じローカルLLMを複数の役職として使い、対象RepositoryをRead-onlyで調査・監査し、必要に応じてAgent同士がTask Broker経由で作業を委任しながら、Evidence付きの改善案を作ります。

```text
CEO（人間）
  ↓
Director
  ↓
Task Broker
  ├─ Researcher
  ├─ Auditor
  ├─ Improvement Planner
  └─ Reviewer

Secretary / Run Store
  ↓
Run / Task / Evidence記録
```

v1では対象Repositoryの自動修正・git commit・git pushは行いません。

## Source of Truth

現在の正式要件は [`REQUIREMENTS.md`](REQUIREMENTS.md) を参照してください。

Web / Electron制作に関係する共通Ruleは `EliteMay/web-project-guide` のCurrent `main` をSource of Truthとして扱います。

## 初期環境

- Windows
- Node.js 20+
- LM Studio
- Qwen3-8B
- 初期対象: PC上のローカルGit Repository

## 現在の実装状態

AI Company v1 のRead-only FoundationとE2E Orchestratorがあります。

現在実装済み:

- LM Studio OpenAI互換API接続
- 同じQwen3-8Bを役職別Promptで利用
- Directorによる初期Task委任
- AgentからのStructured Delegation Request
- Deterministic Task BrokerによるRoute / Depth / Task数 / Model Call数 / Retry制御
- Auditor / Researcher / Improvement Planner / Reviewerの順次実行
- Planner / Reviewerを必ず通す安定した外側Pipeline
- 対象Repository専用Read-only Reader
- `.env` / private key / credential系Fileの基本的なModel Context除外
- Bounded Repository Context
- JSON Schema相当の出力Validationと1回だけの修正再試行
- Local Run Evidence保存
- Node built-in test / GitHub Actions

現在未実装:

- 外部Web検索 / Web Research Tool
- GitHub Read-only direct mode
- Published Evidenceの自動連携
- Engineer Agent / 自動修正
- Single / Fixed Pipeline / Brokered Multi-Agentの本格Benchmark

Researcherは現段階では**Repository内Evidenceの追加確認だけ**を行い、外部Web調査を行ったと偽らないContractになっています。

## コマンド

### LM Studio接続確認

```powershell
npm run doctor
```

### RepositoryをRead-only確認

```powershell
npm run inspect -- --repo "D:\path\to\repo"
```

Text検索もできます。

```powershell
npm run inspect -- --repo "D:\path\to\repo" --search "TODO"
```

### AI Companyを実行

LM Studioで `qwen/qwen3-8b` をロードしてから実行します。

```powershell
npm run company -- --repo "D:\path\to\repo" --goal "このRepositoryの改善点と改善方法をEvidence付きで監査する"
```

実行結果はDefaultで次へ保存されます。

```text
runtime-data/
└─ runs/
   └─ <run-id>/
      ├─ run.json
      ├─ tasks.json
      ├─ findings.json
      ├─ research.json
      ├─ review.json
      └─ summary.md
```

`runtime-data/` はGit管理対象外です。

### Test

```powershell
npm test
```

## 安全境界

- 対象Repository用ReaderにはCreate / Update / Delete APIを持たせない
- Agentが他Agentを直接起動せず、Task Brokerへ委任要求を返す
- Model outputをPermission判定として使わない
- Repository内容はUntrusted DataとしてPromptへ渡す
- 明らかなCredential FileはModel Contextへ入れない
- Agent間の長い自由会話ではなくStructured Resultを引き継ぐ
- Task / Delegation / Model Callには上限を設ける
- Audit結果は命令ではなくEvidence / Proposalとして扱う

## 方針

- Agentの自由な委任要求は許可する
- 実際のTask配送・Permission・Loop防止はDeterministicなTask Brokerが管理する
- 対象Repositoryはv1ではRead-only
- Agent間の引き継ぎはStructured Dataを基本とする
- Audit結果はCurrent Repository / Requirementsの第二Source of Truthにしない
- Local保存をDefaultとし、外部Publishは明示操作で行う
- Single Agent / Fixed Pipeline / Brokered Multi-Agentを実測比較する

詳細は [`REQUIREMENTS.md`](REQUIREMENTS.md) を参照してください。
