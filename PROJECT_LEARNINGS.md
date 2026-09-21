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


## PL-005 — Installer化ではRuntime DataをProgram Filesへ書かない

- Date: 2026-09-21
- Type: Distribution / Reliability
- Status: Adopted
- Problem: Developer起動ではRepository直下の `runtime-data/runs` が使えるが、そのままSetup.exe化するとInstall先がProgram Files等の書込みに不向きなPathになり得る。
- Risk: Coverage Checkpoint / Synthesis /履歴保存がPermission Errorで失敗し、Auto UpdateでApp本体を置き換える際にUser Dataも巻き込む。
- Adopted Pattern: Setup.exe版はElectron `userData/runtime-data/runs` をRuntime Data rootにし、CLI child processへ `LOCAL_AI_RUNTIME_DATA_ROOT` を渡す。Developer起動は従来Pathを維持する。
- Migration: 既存local-ai-lab Repositoryを既定Repositoryとして認識できる場合、初回配布版起動時に旧Run DataをuserDataへCopyする。
- Regression Guard: Desktop distribution contract test。
- Prevention: Installer化するときはSource PathとWritable User Data Pathを同一視しない。

## PL-006 — Repository同期はAI Write Capabilityと分離する

- Date: 2026-09-21
- Type: Security / UX
- Status: Adopted
- Problem: UserはGUIからPC上のRepositoryを最新版にしたいが、AI Company v1のAudit ContractはTarget Repository Read-onlyを維持する必要がある。
- Decision: `GitHubから最新化` はModel/Agent ToolではなくUserが明示的に押すDesktop Maintenance Capabilityとして分離する。
- Safety: clean working treeを要求し、`git fetch --prune origin` + `git pull --ff-only` のみ許可。dirty / detached HEAD / non-fast-forwardでは停止し、commit / push / reset / rebase / forceを提供しない。
- Regression Guard: Desktop distribution contract test。
- Prevention: User maintenance operationとAI autonomous permissionを同じCapabilityとして扱わない。

## PL-007 — Auto Updater導入VersionはBootstrap Releaseとして扱う

- Date: 2026-09-21
- Type: Distribution
- Status: Adopted
- Problem: Updaterを持たない旧Versionは、自分自身を遠隔でUpdater搭載Versionへ更新できない。
- Decision: v0.2.0をAuto Updater Bootstrap Versionとし、このVersionだけSetup.exeを1回手動Installする。以後はGitHub Releases + electron-updaterでOne-click Updateする。
- Release Contract: package version / Setup.exe / latest.yml / blockmapを同Versionで生成し、同じReleaseへ公開する。同じVersion Releaseが既に存在する場合は後からAssetを差し替えない。
- Failure Fallback: Update失敗時はCurrent Versionを継続利用し、固定GitHub Releases URLをManual fallbackにする。
- Remaining Risk: Code Signing未導入のためSmartScreen警告が出る可能性がある。


## PL-008 — Runtime Process管理は任意Shellと分離する

- Date: 2026-09-21
- Type: Security / UX
- Status: Adopted
- Problem: Bonsai利用のたびにUserがPowerShellを開いて固定Commandを実行する必要があり、Desktop ControllerだけでPrimary Flowが完結しなかった。
- Decision: Bonsai 2 27Bだけを対象に、既知の `start_llama_server.ps1` を固定Environment / 固定Argumentで起動する専用Runtime ControllerをMain Processへ追加する。
- Safety: Rendererへ任意Shell Capabilityを渡さず、Desktopが起動したProcessだけをStop対象とする。外部起動Serverは検出だけしてKillしない。
- Lifecycle: Start / StopはUserの明示Button操作だけで行う。Desktop起動時・終了時に自動Start / Stopしない。
- Regression Guard: Bonsai start spec unit test + Desktop IPC/security contract test。
- Prevention: Local Runtime起動をGUI化するときは、User convenienceのためにGeneric Terminal / Generic Shell Capabilityへ広げない。


## PL-009 — Electron標準Iconを配布AppのIdentityに使わない

- Date: 2026-09-21
- Type: UX / Distribution
- Status: Adopted
- Problem: Electron標準Iconのままだと、他Electron AppとTaskbar / Desktop Shortcut上で見分けにくい。
- Decision: Local AI Lab専用IconをRepository Assetとして管理し、Electron WindowとWindows packageの両方へ同じIconを設定する。
- Asset: `desktop/assets/icon.svg` を唯一の編集用Sourceとし、起動/Build前にsmall-size PNGとmulti-size ICOを生成する。
- Regression Guard: Distribution testでVersion / Windows icon path / BrowserWindow icon / AppUserModelId / Binary Asset existenceを確認する。
- Prevention: Desktop AppをSetup.exe配布する段階で、Default framework iconのままReleaseしない。


## PL-010 — signAndEditExecutable=false はWindows Icon埋め込みも止める

- Date: 2026-09-21
- Type: Failure / Distribution
- Status: Resolved
- Symptom: v0.2.3でcustom PNGを設定しWindows buildも成功したが、実機のTitlebar IconがElectron既定Iconのままだった。
- Root Cause: `win.signAndEditExecutable=false` により、Code SigningだけでなくWindows executable resource編集も無効化していた。electron-builder v26ではこのresource編集がApp Icon埋め込みも担当する。
- Final Fix: `signAndEditExecutable=true` に戻し、`signExecutable=false` で署名だけを明示的に無効化する。
- Regression Guard: Distribution testで両設定を固定し、Windows CIでpackaged exeからAssociated Iconを抽出できることを確認する。
- Prevention: Windowsで未署名buildを作る場合、Signing無効化とResource Editing無効化を同一設定として扱わない。


## PL-011 — Desktop Iconは512pxだけで判断しない

- Date: 2026-09-21
- Type: Failure / Visual Quality
- Status: Resolved
- Symptom: custom IconをWindows exeへ埋め込めても、Taskbarの小サイズ表示では白い箱と細い線のように見え、識別できなかった。
- Root Cause: 512px前提の細いAI文字・波形をそのまま縮小し、小サイズごとの判読性とmulti-size ICOを検証していなかった。
- Final Fix: Iconを「濃紺Tile + 太い青いL + シアンDot」へ単純化し、16/24/32/48/64/128/256pxを含むICOをBuild前に生成する。
- Regression Guard: Windows CIでICO directory entriesを解析し、必要な各Sizeが存在することを確認する。
- Prevention: App IconはSourceの高解像度Previewだけで完成判定せず、16px / 24px / 32pxを最低限確認する。


## PL-012 — 長時間Local AI Runは通常のDesktop Commandとして扱わない

- Date: 2026-09-21
- Type: Reliability / UX
- Status: Adopted
- Problem: Coverage Auditは数分〜数十分続くため、通常の短いDesktop操作と同じLifecycleではSleep、誤終了、完了見逃しがRun Reliabilityへ直結する。
- Decision: Active Command中だけ `prevent-app-suspension` を使用し、Window Close時は明示確認、Background完了時はNotification、User StopはFailureと分離する。
- Boundary: Display Sleepは止めない。Bonsai RuntimeはUserの手動Start / Stop Contractを維持し、Desktop終了時に自動停止しない。
- Regression Guard: Desktop Contract TestでPower Blocker / Close Guard / Cancellation / Notificationを確認する。

## PL-013 — Stream OutputはChunk境界とMemory上限を前提にする

- Date: 2026-09-21
- Type: Reliability
- Status: Adopted
- Problem: Child Processのstdout/stderrは1行単位ではなく任意Chunkで届くため、ChunkごとにsplitするとCoverage Progress行を途中で分断して解析を取りこぼす。またOutputとRenderer Logを無制限に保持すると長時間RunでMemory使用量が増え続ける。
- Decision: Channelごとに未完LineをBufferし、改行まで揃えてProgress解析する。MainのCommand OutputとRendererの表示Logには上限を設ける。
- Regression Guard: Contract Testでpending line buffer / output truncation / Renderer row limitを固定する。

## PL-014 — 「保存しない」設定はPathを実際に永続化しない

- Date: 2026-09-21
- Type: Privacy / UX
- Status: Resolved
- Symptom: 「前回の対象フォルダを保存する」をOFFにしても `defaultRepository` がsettings.jsonへ残っていた。
- Root Cause: Checkboxは自動保存動作だけを制御し、settings serialization自体には反映していなかった。
- Final Fix: OFF時はPersisted `defaultRepository` を空にし、現在Sessionの選択FolderだけRenderer Stateで維持する。
- Regression Guard: Desktop Contract TestでRead / Save両方のPersistence条件を確認する。
