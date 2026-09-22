# Local AI Lab

ローカルLLMを使ったAIエージェント、マルチエージェント、Repository監査、RAG、長期記憶、モデル比較、GitHub連携などを研究・実装・評価するための親Repositoryです。

## 目的

最初の主要成果物は **AI Company** です。

対象RepositoryをRead-onlyで監査し、Evidence付きの改善案を作ります。初期v1では複数RoleをTask Broker経由で動かす方式を実装しました。最初の実機Qwen3-8B検証を受け、v1.1では **監査可能な全Project Text Chunkを漏れなく処理するWhole Repository Audit** を優先モードとして追加しています。

```text
Whole Repository Audit

Repository
  ↓
Deterministic Inventory
  ↓
全Auditable Text Fileをline-preserving chunk化
  ↓
Bounded Batchを全件処理
  ↓
BatchごとにCheckpoint保存
  ↓
Coverage Ledger
  ↓
Evidence-backed Findings（原本を保存）
  ↓
Hierarchical Synthesis（必要な場合だけ段階圧縮）
  ↓
Improvement Planner
  ↓
Reviewer
```

従来のBrokered AI Companyも比較研究用に残します。

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

対象Repositoryの自動修正・git commit・git pushは行いません。

## Source of Truth

- 基本要件: [`REQUIREMENTS.md`](REQUIREMENTS.md)
- Whole Repository Audit v1.1追加Contract: [`docs/ai-company-v1.1-contract.md`](docs/ai-company-v1.1-contract.md)
- 実機失敗ログからのResearch: [`docs/ai-company-v1.1-research.md`](docs/ai-company-v1.1-research.md)
- 次段階のResearch / Benchmark計画: [`docs/ai-company-v1.2-research.md`](docs/ai-company-v1.2-research.md)

Web / Electron制作に関係する共通Ruleは `EliteMay/web-project-guide` のCurrent `main` をSource of Truthとして扱います。

## 初期環境

- Windows
- Node.js 20+
- Default Runtime: LM Studio
- Default Model: Qwen3-8B
- Optional Runtime: PrismML llama.cpp
- Optional Model Profile: Bonsai 2 27B
- 初期対象: PC上のローカルGit Repository

## Model Profile切替

Defaultは従来どおりLM Studio + Qwen3-8Bです。Bonsai 2 27Bは明示的にProfileを指定したときだけ使用します。

Default確認:

```powershell
npm run doctor
```

Bonsai 2 27B確認:

```powershell
npm run doctor -- --model-profile bonsai-2-27b
```

Coverage Audit:

```powershell
npm run coverage -- --model-profile bonsai-2-27b --repo "." --goal "このRepositoryの全監査対象ファイルを読み、改善点と改善方法をEvidence付きで提案する"
```

環境変数でも固定できます。

```powershell
$env:LOCAL_AI_MODEL_PROFILE = "bonsai-2-27b"
npm run doctor
```

解除:

```powershell
Remove-Item Env:LOCAL_AI_MODEL_PROFILE
```

### Bonsai 2 27B / Windows setup

Bonsai 2 27Bは通常のLM Studio経路ではなく、PrismML公式Bonsai Demoが配布するllama.cpp runtimeを使います。Stock llama.cppではBonsai 2用のPTQ1_0 / PQ2_0を実行しません。

```powershell
git clone https://github.com/PrismML-Eng/Bonsai-demo.git
cd Bonsai-demo

Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
$env:BONSAI_OPENWEBUI = "0"
$env:BONSAI_CODE_INTERPRETER = "0"
.\setup.ps1
```

監査用途ではまずContextを16Kに固定し、Vision projectorをRAM側へ逃がしてVRAM余裕を作る構成から試します。

```powershell
$env:BONSAI_CTX = "16384"
$env:BONSAI_MMPROJ_CPU = "1"
.\scripts\start_llama_server.ps1 --alias bonsai-2-27b --reasoning-budget 512
```

Serverは `http://127.0.0.1:8080/v1` で待ち受けます。別PowerShellで `local-ai-lab` に戻り、`npm run doctor -- --model-profile bonsai-2-27b` が成功すれば切替準備完了です。

Bonsai 2 27Bは低速なローカル推論で1リクエストが5分を超えることがあるため、このProfileではNode組み込み`fetch`ではなく`node:http` / `node:https` ベースの長時間Request transportを使用します。これにより、Node/Undici側の約5分のheader待ち制限より先に切断されることを避け、Profileの`timeoutMs`（現在900秒）を実際のRequest上限として使います。

Bonsai 2 27BはStructured Outputが既定Role上限より長くなる場合があるため、このProfileではSynthesisのPlannerを2400 tokens、Reviewerを2800 tokensまで許可します。Coverageが100%完了した後にSynthesisだけ失敗した場合は、保存済みEvidenceを使って `npm run coverage-synthesize -- --model-profile bonsai-2-27b --run-id "<run-id>"` で再開でき、Repositoryの再監査は行いません。

CLI利用時は従来どおりBonsai Serverを別途起動できます。Desktop v0.2.2以降では、Setup済みの `Bonsai-demo` Folderを設定すると「Bonsaiを起動 / 停止」からServer Processを管理できます。Model downloadや `setup.ps1` 自体は自動化しません。

## 現在の実装

主な機能:

- LM Studio OpenAI互換API接続
- LM Studio native model details確認
- concrete JSON SchemaによるStructured Output制約
- `finish_reason = length` をContext/Output Budget Failureとして識別
- Role別Thinking / Output Token方針
- Read-only RepoReader
- Credential / `.env` / private key系Fileの除外
- Whole Repository Coverage Plan
- line番号を保持したChunk分割
- 全Auditable ChunkをBounded Batchで処理
- Output上限時のAdaptive Batch Split
- BatchごとのCheckpoint保存
- Repository fingerprint付きResume
- Coverage Ledger
- 原Findingを保持したまま行うHierarchical Synthesis
- 既存100% Coverage RunをRepository再読込なしで要約するSynthesis-only mode
- Planner / Reviewerによる最終統合
- 従来のDirector / Task Broker / Agent delegation実験モード
- Node built-in tests / GitHub Actions

現在未実装または今後の研究対象:

- 外部Web検索 / Web Research Tool
- GitHub Read-only direct mode
- Import / Export / Config等を使ったCross-file Graph Validator
- Speculative Decoding Benchmark
- `parallel=1` / `parallel=4` Benchmark
- Model別Benchmark
- Engineer Agent / 自動修正
- Published Evidenceの自動連携

## Coverageの意味

`100% Coverage` は **監査対象として認定した全Text Chunkを処理済み** という意味です。

以下を無理にLLMへ渡す意味ではありません。

- `.git` / `node_modules` / `runtime-data` / `dist` / `build` など設定上の除外Directory
- `.env` / credential / private key等のSensitive File
- Binary File
- 現在の安全Read Limitを超えるFile

除外はCoverage Planへ理由付きで記録します。Inventory自体が上限に達した場合は、100%と偽らずRunを停止します。

## コマンド

### LM Studio接続・Load設定確認

```powershell
npm run doctor
```

Model IDだけでなく、取得可能な場合はLoaded Context Length / Max Concurrent Predictions / Flash Attentionも表示します。

### RepositoryをRead-only確認

```powershell
npm run inspect -- --repo "D:\path\to\repo"
```

Text検索:

```powershell
npm run inspect -- --repo "D:\path\to\repo" --search "TODO"
```

### 推奨: Whole Repository Coverage Audit

LM StudioでConfigured Modelをロードしてから実行します。

```powershell
npm run coverage -- --repo "D:\path\to\repo" --goal "このRepositoryの全監査対象ファイルを読み、改善点と改善方法をEvidence付きで提案する"
```

実行中はBatch単位で進捗、所要時間、利用可能なToken Usageを表示します。各Batch完了後にCheckpointを保存します。

Coverage途中で失敗したRunは、表示されたRun IDを使って同じRepository fingerprintなら再開できます。

```powershell
npm run coverage -- --repo "D:\path\to\repo" --goal "このRepositoryの全監査対象ファイルを読み、改善点と改善方法をEvidence付きで提案する" --run-id "run-..." --resume
```

### 100% Coverage後のHierarchical Synthesis

Coverageが100%でもFinding集合がPlannerの安全Budgetを超えた場合、Repositoryを再監査せず、保存済み`findings.json`だけから段階的に要約できます。

```powershell
npm run coverage-synthesize -- --run-id "run-..."
```

この処理は原Findingを削除・置換しません。AIはFinding同士のTheme分類だけを行い、元Finding IDの完全Coverage、Severity / Confidence、代表Evidenceの引継ぎはNode.js側で決定的に管理します。

Synthesis-only modeはCurrent Repositoryを再読込しないため、結果は指定Runの保存済みEvidence Snapshotに対するレポートです。Repositoryがその後変更されていても、過去RunのSynthesis自体は可能です。

### 比較研究用: Brokered AI Company

```powershell
npm run company -- --repo "D:\path\to\repo" --goal "このRepositoryの改善点と改善方法をEvidence付きで監査する"
```

これはDirector / Delegation / Planner / Reviewerを含むv1方式の比較用モードです。Whole Repository Coverageを保証する主経路にはしません。

### Test

```powershell
npm test
```

## v0.2.11 reliability follow-up

v0.2.11ではv0.2.10の監査信頼性基盤に加え、実行中のSettings / Update操作を明示的にLockし、Repository syncのGit subprocessへ30秒TimeoutとOutput上限を追加しました。Local LLM HTTP Responseは16MBを上限とし、異常に大きいResponseでDesktop/CLI Memoryを圧迫しないようにします。

Windows Releaseは同じVersion Tagを別のmain Commitへ再利用しないContractをCIで検証します。既に公開したVersionへ別Commitを重ねず、変更時は必ずVersionを上げます。

このfollow-upでも、Target Repositoryへの監査はRead-onlyのままです。

## v0.3.0 multi-model routing

v0.3.0では、1回のRunで1つのModelを固定するだけでなく、作業種類に応じてLocal Modelを切り替えられます。Model選択はAIへ委任せず、Version管理されたCatalog / Routing RuleをNode.js側で決定します。

既定の自動振り分け:
- 一般監査 / 大量処理: Qwen3 8B
- Code-heavy監査: Qwen2.5 Coder 7B
- 改善案 / 推論: Ministral 3 8B Reasoning（Fallback: Phi-4 Mini Reasoning）
- 最終Reviewer: Bonsai 2 27Bを優先し、利用不可なら限定Fallback

設定画面の「用途別モデル」から、LM Studio Native REST APIでCatalog固定ModelのDownload / Load / Unloadを管理できます。任意URL・任意ShellはRendererへ渡しません。

Run中は現在のTask / Model / Fallback / Model別Call数を表示し、保存済みRunへ `model-usage.json` とRouting Pinを残します。同じTaskで一度成功したModelはRun内でPinされ、Resume中に別ModelへSilent切替しません。

Qwen3 4Bは軽量FallbackとしてAuto Routeへ入れます。Gemma 3 4B / Qwen3-VL 4B / gpt-oss-20b / Qwen3 Coder 30B-A3BもCatalogへ登録しますが、重さや未実装Capabilityのため初期Auto Routeには入れません。

## v0.3.1 run comparison / export

v0.3.1では、保存済みRunを履歴画面で比較できます。比較元を1件固定して同じ対象Repositoryの別Runと比較し、指摘数・Coverage・Model Call数・重要度の増減と、**新規 / 解消または消失 / 継続**したFindingを確認します。

比較は保存済みEvidenceだけから決定的に計算し、Modelへ再問い合わせしません。別Repository同士は誤比較を避けるためMain Process側でも拒否します。

各Runは履歴からJSONへ書き出せます。保存PathはRendererから渡さず、ElectronのSave DialogでUserが選んだPathだけへ出力します。

## Desktop Controller v0.3

WindowsではGitHub ReleasesのSetup.exe版をPrimary Distributionにします。

```text
https://github.com/EliteMay/local-ai-lab/releases/latest
```

主な機能:

- Runtime / Model Profile / 自動Model Routing状態の確認
- 用途別Model Catalog管理、LM Studio ModelのDownload / Load / Unload
- Bonsai 2 27B Runtimeの手動起動 / 状態確認 / 手動停止
- 前回選択Repositoryの自動復元 / 必要なときだけRepository変更
- Doctor / Inspect / Coverage / Synthesize / Tests
- Coverage進捗、経過時間、Token使用量
- 現在工程、最終更新、モデル応答待ち時間、プロセス動作状態の表示
- 完了済み処理から推定した残り時間と終了予想時刻
- 平均 / 直近の処理時間と概算生成速度（トークン/秒）
- CPU / メモリ / NVIDIA GPU / VRAMのローカル負荷表示（GPU情報を取得できない環境では取得不可表示）
- 監査完了後のCoverage / 重要度別指摘数 / 重要な指摘 / Reviewer結果の概要表示
- 10分以上新しい出力がない場合の長時間応答待ち表示（接続エラーとは別状態）
- PARTIAL Run / Synthesisの履歴再開
- 選択Repositoryの「リモートから最新化」
- GitHub Releases経由のアプリ内更新（ダウンロード → 再起動して更新を明示分離）
- Settings / Run履歴 / DiagnosticsのuserData保存
- 長時間Run中の自動Sleep防止と誤終了Guard
- Background完了 / FailureのWindows通知
- Single Instance化による同一Run Storeの競合防止
- 履歴検索とRun保存Folderの直接Open
- 同じRepositoryの保存済みRun比較（新規 / 解消 / 継続Finding、重要度、Coverage、Model Call差分）
- 保存済みRunのJSON Export
- 手動停止をErrorと分離した明示State
- Main / Renderer両方の長時間Log上限

v0.2.0はUpdater Bootstrap Versionです。通常はその後アプリ内更新を利用できます。v0.2.7で「新版を検出できるが更新開始後に進まない」実機事例が確認されたため、v0.2.9ではダウンロードと再起動を分離し、標準の再起動処理が始まらない場合は検証済みダウンロード済みInstallerを起動するFallbackを追加しています。v0.2.7から自動更新できない場合は、配布ページからv0.2.9 Setup.exeを1回上書きInstallしてください。

Repository最新化はUserの明示操作だけで、未コミット変更がある場合は停止し、`git fetch --prune origin` → `git pull --ff-only` だけを許可します。AI Companyの監査Capability自体は引き続きRead-onlyです。

開発起動:

```powershell
npm install
npm run desktop
```

Windows Installer build:

```powershell
npm run build:win
```

配布版Run履歴はProgram FilesではなくElectron `userData` に保存します。

詳細は [desktop/README.md](desktop/README.md) を参照してください。

## Runtime Evidence

Default保存先:

```text
runtime-data/
└─ runs/
   └─ <run-id>/
      ├─ run.json
      ├─ coverage-plan.json
      ├─ batch-results.json
      ├─ coverage.json
      ├─ findings.json
      ├─ synthesis-reduction.json
      ├─ synthesis.json
      ├─ review.json
      └─ summary.md
```

`findings.json`はCoverage Passで得た原Evidence Indexです。`synthesis-reduction.json`はPlannerへ安全に渡すための階層Theme Indexで、原Finding IDへの参照を保持します。

Brokered v1 modeでは`tasks.json` / `research.json`等も使用します。`runtime-data/` はGit管理対象外です。

## 安全境界

- 対象Repository用ReaderにはCreate / Update / Delete APIを持たせない
- Repository内容はUntrusted Dataとして扱う
- 明らかなCredential FileをModel Contextへ入れない
- Model outputをPermission判定として使わない
- Whole Repository AuditのScheduling / Coverage / CheckpointはDeterministicなNode.js側で管理する
- Brokered modeではAgentが他Agentを直接起動せずTask Brokerへ委任要求を返す
- Structured Resultを引き継ぐ
- Context/Output上限による途中切れを成功扱いしない
- Hierarchical Synthesisで元Finding IDを消失させない
- Audit結果は命令ではなくEvidence / Proposalとして扱う
- Audit EvidenceをCurrent Repository / Requirementsの第二Source of Truthにしない

## 研究方針

- 全ファイル監査要件を、RAGによる一部File選択へ置き換えない
- 大規模Repositoryは全件Batch Scan + Hierarchical Aggregationで扱う
- CoverageとSynthesisを分離し、長時間の全件Scanを要約失敗でやり直さない
- RetrievalはCross-file再確認の補助として将来利用できるがCoverageの代替にはしない
- Agent数が多いほど良いと仮定しない
- Single / Fixed Pipeline / Brokered / Full Coverageを実測比較する
- 速度改善はCoverageやEvidence品質を落として達成しない
