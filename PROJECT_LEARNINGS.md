# Project Learnings

このFileは、local-ai-labで再発価値のある失敗・成功・予防策だけを残すDurable Project Memoryです。日々の変更履歴はGit history / PRへ分離します。

## PL-001 — 長時間Local LLM Requestが約5分で切断された

- Date: 2026-09-20
- Type: Failure
- Status: Resolved / monitoring
- Symptom: Bonsai 2 27BのCoverage Auditが各Attempt約5分で `fetch failed` になり、Server側では `cancel task` が記録された。
- Expected: Profileの `timeoutMs=900000` に従い、15分までLong-running Requestを待つ。
- Actual: Node built-in fetch / Undici側のheader wait制限が先に働き、Modelが生成中でもRequestが切断された。
- Trigger: Bonsai 2 27Bのように1 Requestが5分を超える低速Local推論。
- Root Cause: Application-level AbortController timeoutだけを設定し、HTTP transport自身の待ち制約を考慮していなかった。
- Final Fix: Bonsai Profileだけ `node:http` / `node:https` transportへ切り替え、既存LM Studio / Qwen pathは変更しない。
- Affected: `src/model/lm-studio-client.mjs`, `config/model-profiles/bonsai-2-27b.json`
- Detection: llama.cpp Server logとCoverage elapsed timeの照合。
- Regression Guard: delayed response / configured timeoutのNode test。
- Prevention: Slow local modelを追加するときはModel timeoutだけでなくTransport timeoutも実測する。

## PL-002 — Coverage 100%でもSynthesisのOutput上限でPARTIALになった

- Date: 2026-09-20
- Type: Failure
- Status: Resolved / monitoring
- Symptom: Coverageは100%完了したがImprovement Plannerが1400 tokensを使い切り、RunがPARTIALになった。
- Expected: 保存済みEvidenceからPlanner / Reviewerまで完了できる。
- Actual: Model固有のStructured Output量がRoleの固定上限を超えた。
- Root Cause: Role default token budgetを全Model共通の固定値として利用していた。
- Final Fix: Coverage SynthesisのPlanner / Reviewer output budgetをModel Profileからoverride可能にし、Bonsaiだけ増加。
- Affected: `src/core/coverage-orchestrator.mjs`, `src/core/coverage-synthesis.mjs`, Bonsai Profile
- Regression Guard: immediate synthesis / synthesis-only recovery両方のbudget override test。
- Prevention: Model差が大きいParameterはRole defaultとModel Profile overrideを分離する。

## PL-003 — DesktopのCommand Cardが選択と実行を兼ねていた

- Date: 2026-09-21
- Type: UX Failure
- Status: Resolved in Desktop v0.2
- Symptom: Synthesize等のCommand Cardを押すと、Run ID等の必要入力を確認する前に即実行された。
- Expected: Taskを選択し、必要Inputを確認してから明示的にRunを開始する。
- Actual: Card click handlerが `selectCommand` と `run` を同時に行っていた。
- Root Cause: PowerShell Command launcherとして最小実装したFlowを、長時間AI Run Controllerへそのまま拡張した。
- Final Fix: Task selectionとExecute actionを分離し、HistoryからのResumeも「再開準備 → 明示実行」に統一。
- Affected: `desktop/renderer/*`
- Regression Guard: Renderer source contract testでCommand clickから直接 `run()` しないことを確認。
- Prevention: 長時間・高Cost処理はSelection / Configuration / Execute / Progress / Recoveryを別Stateとして設計する。

## PL-004 — ElectronのSecurity設定だけではIPC Boundaryが不十分

- Date: 2026-09-21
- Type: Security Improvement
- Status: Resolved in Desktop v0.2
- Problem: `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true` は維持していたが、Privileged IPC handlerでSender validationを行っていなかった。
- Adopted Pattern: 共通 `registerIpc` wrapperでRenderer URLを検証し、外部Navigation / new windowを拒否。Rendererにはrestrictive CSPを設定。
- Trade-off: file:// Renderer URLに強く結び付くため、将来Custom Protocolへ移行する場合はSender validationを同時に更新する必要がある。
- Regression Guard: Desktop security contract test。
- Reuse Condition: ElectronでRendererからMain ProcessへFile / Process / Clipboard等のCapabilityを渡す場合。
