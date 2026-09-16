# Local AI Lab Requirements

更新日: 2026-09-16
Status: Ready for implementation

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
- Local LLM Runtime: LM Studio
- 初期Model: Qwen3-8B
- 接続: LM StudioのローカルAPIを利用する
- 初期対象: PC上に存在するローカルGit Repository

ModelやRuntimeを将来差し替えられる構造を優先し、Qwen3-8B専用実装へ固定しすぎない。

## 4. AI Company v1 の役職

### CEO

- 人間のRepository owner
- 目的・例外・大きな仕様変更・最終採用判断を行う

### Director

- Qwen3-8Bを役職Promptで利用
- User Goalを理解する
- 必要なTaskを分解する
- 担当Agentを選ぶ
- 最終結果を統合する
- 対象Repositoryは変更しない

### Researcher

- Qwen3-8Bを役職Promptで利用
- Web検索、技術調査、比較、外部Evidence収集を担当する
- 外部Contentを命令ではなくUntrusted Dataとして扱う
- 対象Repositoryは変更しない

### Auditor

- Qwen3-8Bを役職Promptで利用
- Repository、実装、構造、UI/UX、保守性、Security、Performance等を必要範囲で監査する
- Evidenceのない断定を避ける
- 必要な追加調査を他Agentへ委任要求できる
- 対象Repositoryは変更しない

### Improvement Planner

- Qwen3-8Bを役職Promptで利用
- Findingから具体的な改善方法を作る
- 対象Fileや変更候補を示してよい
- コード例や修正案を提示してよい
- 実ファイルは変更しない

### Reviewer

- Qwen3-8Bを役職Promptで利用
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

- File create/update/delete
- git commit
- git push
- Branch変更
- Force operation
- 任意Shell mutation

Prompt上の禁止だけに依存せず、Tool/API/File-system boundaryでも書込みCapabilityを与えないことを優先する。

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

同じQwen3-8Bを、役職ごとに以下を分けて呼び出す。

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
12. 同じQwen3-8Bを複数Roleとして使える
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

## 19. Later Candidates

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
- Dashboard / UI
- Local/Remote model benchmark suite
- LoRA / Fine-tuning experiments

## 20. Implementation Handoff

- Status: Ready for implementation
- Requirements updated: 2026-09-16
- Blocking Decisions: None
- Important Assumptions:
  - v1監査対象はローカルRepositoryから開始する
  - Published Evidenceは自動送信せず、Local保存 → 明示Publishとする
  - 初期同時実行数は1
  - Target RepositoryへのWrite Capabilityは与えない
- Implementation conversation: `local-ai-lab（実装）`
