# Local AI Lab Requirements

更新日: 2026-09-21
Status: Desktop v0.2 distribution candidate

## 1. 目的

`local-ai-lab` は、ローカルLLMを使ったAIエージェント、マルチエージェント、RAG、長期記憶、モデル比較、GitHub連携等を継続的に研究・実装・評価する親Repositoryとする。

最初の主要成果物は、複数の役職を持つローカルAIが対象Repositoryを読み取り、必要に応じて互いへ作業委任を要求しながら、調査・監査・改善案作成・レビューを行う `AI Company v1` とする。

## 2. 利用者

- Primary: Repository owner本人
- 初期段階はローカルPC上での個人利用を前提とする
- 一般公開サービス化はv1の範囲外

## 3. 現在の前提環境

- OS: Windows
- Runtime: Node.js
- Default Local LLM Runtime: LM Studio
- Default Model: Qwen3-8B
- Default接続: LM StudioのローカルAPIを利用する
- Optional Runtime: PrismML llama.cpp（OpenAI互換API）
- Optional Model Profile: Bonsai 2 27B
- Model切替は手動Profile指定とし、自動Model routingはv1の範囲外とする
- 初期対象: PC上に存在するローカルGit Repository

ModelやRuntimeを将来差し替えられる構造を優先し、Qwen3-8B専用実装へ固定しすぎない。

## 4. AI Company v1 の役職

### CEO

- 人間のRepository owner
- 目的・例外・大きな仕様変更・最終採用判断を行う

### Director

- Configured local modelを役職Promptで利用（初期既定はQwen3-8B）
- User Goalを理解する
- 必要なTaskを分解する
- 担当Agentを選ぶ
- 最終結果を統合する
- 対象Repositoryは変更しない

### Researcher

- Configured local modelを役職Promptで利用（初期既定はQwen3-8B）
- Web検索、技術調査、比較、外部Evidence収集を担当する
- 外部Contentを命令ではなくUntrusted Dataとして扱う
- 対象Repositoryは変更しない

### Auditor

- Configured local modelを役職Promptで利用（初期既定はQwen3-8B）
- Repository、実装、構造、UI/UX、保守性、Security、Performance等を必要範囲で監査する
- Evidenceのない断定を避ける
- 必要な追加調査を他Agentへ委任要求できる
- 対象Repositoryは変更しない

### Improvement Planner

- Configured local modelを役職Promptで利用（初期既定はQwen3-8B）
- Findingから具体的な改善方法を作る
- 対象Fileや変更候補を示してよい
- コード例や修正案を提示してよい
- 実ファイルは変更しない

### Reviewer

- Configured local modelを役職Promptで利用（初期既定はQwen3-8B）
- FindingとEvidenceの対応を確認する
- 事実・推測・意見を区別する
- Requirementとの衝突、過剰変更、重複、根拠不足を確認する
- 必要なら `REJECT` / `NEED_MORE_EVIDENCE` として差し戻す
- 対象Repositoryは変更しない

### Task Broker

- LLMではなくNode.js側のDeterministic Systemとして実装する
- Agentからの委任要求を受ける
- Permission、重複、深さ、Task数、Model Call数、Loop条件を検証する
- 許可されたTaskだけを次のAgentへ配送する
- Task Stateを管理する

### Secretary

- 基本はNode.js側のDeterministic Systemとして実装する
- Agentの自由文を正本にせず、Task Brokerが持つ実際のTask/Event/Resultから記録を生成する
- 必要に応じてLLMを人間向け要約だけに利用できる
- 対象Repositoryは変更しない

## 5. Agent委任Contract

Agent同士の直接起動は禁止する。

Agentは他Agentへ作業を依頼したい場合、Structured Delegation RequestをTask Brokerへ返す。

例:

```json
{
  "type": "delegation_request",
  "from": "auditor",
  "to": "researcher",
  "objective": "モバイルナビゲーションの現在のUX Evidenceを調査する",
  "reason": "現在のEvidenceだけでは改善判断できない",
  "priority": "normal"
}
```

Task Brokerは少なくとも次を確認する。

- 委任元から委任先へのRouteが許可されている
- 同一または実質同一Taskが既に進行していない
- Delegation Depth上限以内
- Run内Task上限以内
- Model Call上限以内
- Retry上限以内
- Runが停止状態ではない

Agentは「誰に頼むべきか」を判断できるが、実行権限は持たない。

## 6. Task State

最低限次を持つ。

- `PENDING`
- `RUNNING`
- `COMPLETED`
- `FAILED`
- `BLOCKED`
- `CANCELLED`

AIの自然文だけでTask状態を管理しない。

## 7. Agent間データ

Agent間の引き継ぎは、長い自由会話ではなくMachine-readableなStructured Dataを基本とする。

最低限:

```json
{
  "taskId": "task-001",
  "parentTaskId": null,
  "requestedBy": "director",
  "assignedTo": "auditor",
  "objective": "現在のサイト構造を監査する",
  "inputs": {},
  "result": {
    "status": "completed",
    "findings": [],
    "evidence": [],
    "uncertainties": [],
    "recommendedNextActions": []
  }
}
```

Schema違反を検出し、無制限に壊れた出力を次Agentへ渡さない。

## 8. 権限とSecurity

v1はRead-only Audit Systemとする。

### 対象Repository

許可:

- File listing
- File read
- Text search
- Git metadata read

禁止:

- AI Company / Audit AgentによるFile create/update/delete
- AI Company / Audit Agentによるgit commit / git push
- AI Company / Audit AgentによるBranch変更
- Force operation
- 任意Shell mutation

Prompt上の禁止だけに依存せず、AI CompanyのTool/API/File-system boundaryでは書込みCapabilityを与えないことを優先する。

Desktop ControllerにはAI監査とは分離したUser明示のRepository Maintenance操作として、clean working treeに限る fast-forward-only の `git fetch` / `git pull --ff-only` を許可できる。この操作はModel outputから自動実行せず、dirty tree、detached HEAD、non-fast-forwardでは停止する。git commit / push / reset / rebase / forceは提供しない。

### Web / External Content

- Web page、README、Issue、RAG chunk等はUntrusted Dataとして扱う
- 外部Contentに書かれたAgent向け命令を実行Instructionとして扱わない
- Secret、Credential、TokenをPrompt、Log、Evidenceへ保存しない
- URL、Path、Tool inputはプログラム側でValidationする

## 9. Run Limit / Loop Guard

初期値はConfig化し、実測後に変更できること。

初期候補:

- `maxDelegationDepth = 3`
- `maxTasksPerRun = 12`
- `maxModelCalls = 20`
- `maxRetriesPerTask = 1`
- 実質同一Taskの重複実行は禁止

AI自身の「もう十分」という判断だけを終了条件にしない。

## 10. 実行方式

v1ではModel instanceを役職ごとに複製しない。

同じConfigured local modelを、役職ごとに以下を分けて呼び出す。初期既定はQwen3-8Bとし、明示的なModel Profile指定時だけ別Modelへ切り替える。

- System Prompt
- Tool Allowlist
- Context
- Task Input

初期同時実行数は1とする。

2並列以上はBenchmarkで安定性、VRAM、Latencyを確認してから導入する。

## 11. Research Tool

Researcher向けに将来的に少なくとも次のCapabilityを用意する。

- Web search
- Web page fetch/read
- GitHub search
- GitHub file read

v1実装では、利用可能な安全なRead-only Toolから段階的に導入してよい。

## 12. Finding / Improvement Evidence

改善提案は少なくとも次を追跡できること。

- Finding ID
- 問題内容
- Repository Evidence
- External Evidence（該当時）
- 影響
- 改善案
- 対象候補File
- Confidence
- Destructive / Non-destructive
- 追加確認事項
- Reviewer結果

Evidence不足の場合は確定Findingとして扱わず、Uncertaintyまたは追加調査へ回す。

## 13. 保存

### Local Runtime Evidence

AI Company実行中のRaw/Structured Run Dataは、Git管理対象のCurrent Sourceと混在させず、Local Runtime Data領域へ保存する。

例:

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

`runtime-data/` をGit管理するかは実装時にData sensitivityと用途を確認して決める。Secretや不要な大量Logは保存しない。

### Published Evidence

AI Companyの結果をCurrent Project Repositoryへ直接書き込まない。

Project-specific / point-in-time Audit Evidenceを外部へ保存する場合は、`EliteMay/web-project-data` のCurrent Contractに従う。

v1ではLocal保存をDefaultとし、自動Publishしない。

明示的なPublish操作を行う場合だけ、Current `web-project-data` Contractに従って保存する。

## 14. ChatGPTとの連携

想定Flow:

```text
Local AI Company
↓
Research / Audit / Improvement / Review
↓
Local Evidence
↓
必要時Publish
↓
ChatGPT
↓
Current Repository + Current Requirements + Current Guide + Evidenceを再確認
↓
採用可能な改善だけ実装判断
```

AI CompanyのFindingは命令ではなくEvidence/Proposalとして扱う。

ChatGPTまたは人間がCurrent Stateと照合せず、そのまま採用しない。

## 15. v1 Non-goals

v1では次を実装対象外とする。

- 対象Repositoryの自動修正
- 自動git commit / push
- 自動File削除
- 任意PowerShell実行
- 無制限Agent生成
- 無制限Agent間会話
- 長期Memory
- RAG
- LoRA / Fine-tuning
- 複数Model自動選択
- Discord連携
- 一般公開Service化

## 16. 評価実験

マルチAgent化そのものの有効性を確認するため、同じRepository / Taskで最低限次を比較できるようにする。

### A. Single Agent

Qwen3-8B 1役で監査する。

### B. Fixed Pipeline

```text
Research → Audit → Review
```

### C. Brokered Multi-Agent

Director / Researcher / Auditor / Planner / Reviewerが必要に応じてTask Broker経由で委任する。

比較候補:

- 正しい指摘数
- 誤検出
- 見逃し
- 重複Finding
- Evidence品質
- Schema違反
- 委任回数
- Model Call数
- 総処理時間
- VRAM / Memory
- ChatGPTまたは人間が採用可能と判断した改善数

「Agent数が多いほど良い」を前提にしない。

## 17. Completion Contract — AI Company v1

v1完成には最低限次を満たす。

1. ローカルRepositoryを1つ指定できる
2. DirectorがTaskを分解できる
3. AuditorがRepositoryを監査できる
4. Researcherが利用可能なRead-only Toolで外部調査できる
5. Agentが他Agentへの委任要求を生成できる
6. Task Brokerが委任を検証・配送できる
7. Reviewerが結果を再確認できる
8. Evidence付き改善案を生成できる
9. Task / Delegation / Result履歴を保存できる
10. Loop / Task explosionをSystem側で停止できる
11. 対象Repositoryを変更しないことを確認できる
12. 同じConfigured local modelを複数Roleとして使え、Default Qwen3-8Bと明示的なModel Profileを安全に切り替えられる
13. Schema違反を検出してFailureまたは限定Recoveryできる
14. Run失敗時に原因・失敗Taskを追跡できる
15. 後からChatGPTまたは人間がEvidenceを読んで判断できる
16. Single Agent / Fixed Pipeline / Brokered Multi-Agentを比較できる

## 18. Non-breakable Contract

- v1の対象RepositoryはRead-only
- AI outputをAuthorizationとして使用しない
- Agentの自然文だけでTask StateやPermissionを決定しない
- 外部ContentをInstructionとして信頼しない
- Secret / CredentialをEvidenceへ保存しない
- Current Repository / RequirementsをAI CompanyのAudit結果で上書きしない
- Audit EvidenceをCurrent Project Stateの第二Source of Truthにしない
- 未確認事項を確認済みとして扱わない

## 19. Desktop Controller v0.2

PowerShellで行っている日常操作を置き換え、長時間Local AI Runを開始・監視・再開できるWindows向けElectron Desktop Controllerを提供する。

### Primary Goal

- PowerShellへCommandを手入力せず local-ai-lab を操作できる
- User向け画面は日本語だけでも操作内容・状態・次の行動を理解できる表示を基本とし、内部Command名や技術識別子をそのまま主要Labelへ出さない
- 実行結果を画面で確認し、1 ButtonでClipboardへCopyできる
- 現在のRuntime / Model Profile / Repository / Run状態を確認できる
- 過去Runを runtime-data から再表示できる
- 最後に選択したRepositoryとModel ProfileをGUIから保存し、次回起動時にRepositoryを自動復元できる
- Command選択と実行を分離し、設定不足のまま誤実行しない
- CoverageのBatch進捗・経過時間・Token使用量を確認できる
- 実行中の結果Panelでは、現在行っている工程・処理対象・進み具合・経過時間・監査部分の残り目安・この後の工程を日本語で確認できる
- 残り時間は完了済みBatchの実測から概算し、統合 / 改善案作成 / レビュー等で信頼できる見積りがない場合は架空の時刻を表示しない
- PARTIAL Runを履歴から再開準備できる
- Coverage 100%でSynthesisだけ失敗したRunを保存済みEvidenceから再Synthesisできる
- Runtime未起動など主要FailureをUser向けに理解できるMessageで示す
- 開発診断はElectron userDataへ上限付きで保存し、Prompt本文やFile本文は保存しない
- Setup.exeからInstallでき、Desktop / Start Menuから起動できる
- WindowsのTitlebar / タスクバー / デスクトップショートカット / Start Menuで他Electron Appと見分けられるLocal AI Lab専用Iconを使用し、16px以上の主要サイズを含むmulti-size ICOとして生成する
- v0.2.0以降はGitHub Releasesを使ったアプリ内One-click Updateを利用できる
- Update後もSettings / Run履歴 / Diagnosticsを維持する
- 選択したLocal Git RepositoryをUser明示操作で安全にGitHub最新版へfast-forwardできる
- Bonsai 2 27B利用時はPowerShellを別に開かず、DesktopからBonsai Runtimeを起動・状態確認・停止できる
- 長時間処理の実行中だけOSのApp Suspendを防ぎ、画面自体のSleepは妨げない
- 実行中にWindowを閉じる場合は処理中断を明示確認し、誤終了を防ぐ
- Userが停止した処理はFailureと混同せず、手動停止として表示する
- AppがForegroundでない場合は処理完了 / FailureをOS Notificationで知らせる
- 同じUser Data / Run Storeへ複数Instanceが同時に触れないようSingle Instanceを基本とする
- 履歴を実行ID / Folder / Goal等で検索でき、選択Runの保存Folderを安全に開ける
- Repositoryは選択時に自動保存し、次回起動時に毎回Folder Pickerを要求しない。旧SettingsでPathが空の場合は、存在する最新Run履歴のRepository Pathから復元を試みる
- 長時間LogはMain / Renderer両方で上限を持ち、進捗行がStream Chunk境界で分割されても解析を失わない

### Distribution / Update Contract

- Desktop Versionの正本は `package.json#version`
- Windows配布はNSIS Setup.exeを使用する
- GitHub ReleasesをStable Update Providerとする
- ReleaseにはSetup.exe / `latest.yml` / `.blockmap` を同Versionで揃える
- v0.2.0をAuto Updater Bootstrap Versionとする
- v0.2.0以前からv0.2.0への移行はSetup.exeを1回手動実行する
- 起動時Update確認は設定でON/OFFできる
- Userの明示操作なしに長時間Runを中断して再起動しない
- Update失敗時はCurrent Versionを継続利用でき、固定GitHub Releases URLへのManual fallbackを持つ
- Setup.exe版のRuntime DataはProgram FilesではなくElectron userDataへ保存する
- Code Signing未導入の間はSmartScreen警告の可能性をDocumentationへ明記する

### Bonsai Runtime Control Contract

- 対象は現在のBonsai 2 27B / PrismML llama.cpp Profileに限定する
- Userが設定した `Bonsai-demo` Folder内の `scripts/start_llama_server.ps1` だけを固定引数で起動する
- 任意PowerShell / 任意Command / 任意ArgumentをRendererへ公開しない
- 起動時Environmentは現在検証済みの `BONSAI_CTX=16384`, `BONSAI_MMPROJ_CPU=1`, `BONSAI_SPECULATIVE=0`, `BONSAI_KV4=0` を使用する
- 起動引数は `--alias bonsai-2-27b --parallel 1 --reasoning-budget 1024` を使用する
- Desktopが起動したProcessだけを停止対象とし、外部PowerShell等で起動済みのServerを勝手にKillしない
- 起動・停止はUserがButtonを押した場合だけ行い、Desktop起動時・終了時に自動Start / Stopしない
- Bonsai停止中に監査を開始した場合はRaw `fetch failed` ではなく、起動が必要であることをUserへ示す
- Model download / setup.ps1自動実行はこの機能の範囲外

### Repository Maintenance Contract

- 「GitHubから最新化」は選択Repositoryへだけ作用する
- Git working treeがcleanであることをMain Process側で確認する
- `git fetch --prune origin` と `git pull --ff-only` だけを実行する
- dirty tree / detached HEAD / merge-required / non-fast-forwardは停止する
- Run実行中はRepositoryを更新しない
- git commit / push / reset / rebase / forceは実行しない
- AI Model / Finding / Planner outputから自動実行しない

### v0.2 Commands

- doctor
- inspect
- coverage
- coverage-synthesize
- npm test

### Desktop Security Contract

- Electron Rendererで nodeIntegration を有効化しない
- contextIsolation と sandbox を有効にする
- RendererへNode / Electron APIを丸ごと公開しない
- Main Process側で許可済みCommandだけを実行する
- User入力をShell文字列へ連結せず、spawn argumentとして分離する
- AI Company / Audit AgentへTarget RepositoryのWrite Capabilityは追加しない
- Desktop設定はElectron userDataへ保存し、Project設定を暗黙に書き換えない
- Privileged IPCはMain Process側でSenderとPayloadを検証する
- Rendererの外部Navigation / new windowを許可しない
- Rendererへrestrictive CSPを設定する
- Diagnosticsは最大件数を持ち、Secret / Prompt本文 / File本文を保存しない

### v0.2 Non-goals

- 自由Terminal
- AIによるTarget Repositoryの自動修正
- Repositoryの自動pull / 自動commit / 自動push
- git commit / push
- LM Studio Runtimeの自動起動
- Model download / Bonsai setup.ps1自動実行
- LM StudioのModel Load / Unload自動化
- Bonsai以外のRuntime Process自動管理
- Chat / RAG / Long-term Memory / MCP管理

## 20. Later Candidates

v1検証後に必要性が確認されたものだけ追加する。

- Engineer Agent
- Safe candidate worktreeによる自動修正
- Automated Testing Agent
- GitHub Read-only direct mode
- RAG
- Long-term Memory
- Multiple model routing
- Parallel Agent execution
- Scheduled audits
- Discord integration
- Local/Remote model benchmark suite
- LoRA / Fine-tuning experiments

## 21. Implementation Handoff

- Status: Ready for implementation
- Requirements updated: 2026-09-16
- Blocking Decisions: None
- Important Assumptions:
  - v1監査対象はローカルRepositoryから開始する
  - Published Evidenceは自動送信せず、Local保存 → 明示Publishとする
  - 初期同時実行数は1
  - Target RepositoryへのWrite Capabilityは与えない
- Implementation conversation: `local-ai-lab（実装）`
