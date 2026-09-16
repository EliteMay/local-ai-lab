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

Secretary
  ↓
Run / Task / Evidence記録
```

v1では対象Repositoryの自動修正・git commit・git pushは行いません。

## Source of Truth

現在の正式要件は [`REQUIREMENTS.md`](REQUIREMENTS.md) を参照してください。

Web / Electron制作に関係する共通Ruleは `EliteMay/web-project-guide` のCurrent `main` をSource of Truthとして扱います。

## 初期環境

- Windows
- Node.js
- LM Studio
- Qwen3-8B
- 初期対象: PC上のローカルGit Repository

## 方針

- Agentの自由な委任要求は許可する
- 実際のTask配送・Permission・Loop防止はDeterministicなTask Brokerが管理する
- 対象Repositoryはv1ではRead-only
- Agent間の引き継ぎはStructured Dataを基本とする
- Audit結果は命令ではなくEvidence / Proposalとして扱う
- Local保存をDefaultとし、外部Publishは明示操作で行う
- Single Agent / Fixed Pipeline / Brokered Multi-Agentを実測比較する

詳細は [`REQUIREMENTS.md`](REQUIREMENTS.md) を参照してください。
