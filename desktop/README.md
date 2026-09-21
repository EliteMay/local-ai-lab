# Local AI Lab Desktop v0.2

Local AI Labの監査・再統合・検証Runを、Windows向けElectron GUIから開始・監視・再開するDesktop Controllerです。

## 配布

Windows利用ではGitHub ReleasesのSetup.exeを基本導線にします。

```text
GitHub Releases
↓
local_ai_lab_<version>_setup.exe
↓
WindowsへInstall
↓
Desktop / Start Menuから起動
```

v0.2.0はAuto Updaterを搭載する最初のVersionです。v0.2.0だけはSetup.exeを手動で1回Installします。v0.2.0以降はアプリ内の「更新を確認」「今すぐ更新」からGitHub Releasesの新版を取得し、再起動して更新できます。

Releaseには同一Versionの次のArtifactを揃えます。

```text
local_ai_lab_<version>_setup.exe
local_ai_lab_<version>_setup.exe.blockmap
latest.yml
```

Installerは現在コード署名していないため、Windows SmartScreenが表示される場合があります。Updater MetadataのHash/Integrityはelectron-updaterの標準経路を利用しますが、Authenticode署名による発行元検証はまだありません。

## Primary Flow

```text
Runtime / Model状態確認
↓
Repository選択
↓
Task選択
↓
必要な入力を確認
↓
明示的に実行
↓
進行状況 / 経過時間 / Token使用量を監視
↓
完了 / 停止 / 失敗
↓
履歴から結果確認または再開
```

Command CardのクリックはTask選択だけを行い、その場では実行しません。

## Repositoryを最新化

対象Repository Panelの「GitHubから最新化」は、選択したLocal Git Repositoryを明示操作で更新します。

```text
Git Repository確認
↓
未コミット変更確認
↓
dirtyなら停止
↓
git fetch --prune origin
↓
git pull --ff-only
↓
Before / After SHAを確認
```

- 未コミット変更・Untracked Fileがある場合は更新しない
- Force / reset / rebaseはしない
- AI ModelやAudit結果から自動実行しない
- Run実行中は更新しない
- git commit / git pushは提供しない

これはAI CompanyのRead-only Audit Capabilityとは別の、Userが明示的に押すLocal Repository Maintenance操作です。

## v0.2 Scope

- Runtime / Model Profile状態の確認
- Repository選択
- Repositoryの安全なGitHub最新化
- doctor
- inspect
- coverage
- coverage-synthesize
- npm test相当
- 実行Log表示
- Coverage Batch進捗表示
- 経過時間 / Batch平均からの概算残り時間
- Prompt / Completion / Reasoning Token集計
- PARTIAL Coverageの再開準備
- Coverage 100% + Synthesis失敗RunのSynthesis再開準備
- 結果のClipboard Copy
- Model Profile / Default Repositoryの設定保存
- Electron userDataへのRun履歴 / Settings / 最大100件の診断履歴
- GitHub Releases One-click Update
- 起動時Update確認ON/OFF
- Manual Release page fallback

## Runtime Data

Developer起動では従来どおりRepositoryの `runtime-data/runs` を使います。

Setup.exe版ではProgram Filesへ書き込まず、Electron `userData/runtime-data/runs` を使用します。既存のlocal-ai-lab Repositoryを既定Repositoryとして保持している場合、初回配布版起動時に旧 `runtime-data/runs` をuserDataへCopyするMigrationを試みます。

Updaterでアプリ本体を置き換えても、Settings / Run履歴 / DiagnosticsはuserData側に残ります。

## 開発起動

```powershell
npm install
npm run desktop
```

## Bonsai 2 27B

Bonsai Profileを使う場合、PrismML llama.cpp Serverは別Processとして起動しておく必要があります。

Desktop側で `ECONNREFUSED 127.0.0.1:8080` を検出した場合、Bonsai Runtimeが起動していないことをUser向けMessageとして表示します。

Desktop v0.2はRuntimeのStart / Stop自動化、Model download、Load / Unloadまでは行いません。

## Security Boundary

- Rendererは `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- Sandboxed preloadはCommonJS
- Main Process側で許可済みCapabilityだけを実行
- IPC sender URLとpayloadをMain Process側で検証
- Rendererの外部Navigation / new windowを拒否
- restrictive CSPを設定
- User入力をShell文字列へ連結しない
- App Update Provider / Manual fallback URLは `EliteMay/local-ai-lab` GitHub Releasesへ固定
- Repository Updateはclean tree + fast-forward-only
- Update中も任意URL / 任意ShellをRendererへ公開しない

## Diagnostics

直近100件まで、Command開始・終了・失敗、Repository更新、Update State等の操作EventをElectron userDataへ保存します。

Prompt本文、Repository File本文、Credential等は保存しません。

## Current Limitations

- LM Studio / PrismML Runtime自体の起動は自動化しない
- Model download / Load / Unloadは自動化しない
- 長時間ProcessはAppを閉じると継続管理できない
- 残り時間はBatch平均からの概算
- Installer Code Signingは未導入
- Windows実機でのSetup.exe Install / v0.2.0→次VersionのOne-click UpdateはCIだけでは確認できない
- package-lockは現時点で未追跡
