# Local AI Lab Desktop v0.2

Local AI Labの監査・再統合・検証Runを、Windows向けElectron GUIから開始・監視・再開するDesktop Controllerです。

## 表示言語

Userが直接見る画面は日本語を基本にします。

- 操作名・状態・説明は、日本語だけで意味が分かる表現を優先する
- `doctor` / `coverage` / `coverage-synthesize` 等の内部Command名はCode内部に残してよい
- Local AI Lab、GitHub、LM Studio、Qwen3-8B、Bonsai 2 27B等の固有名詞はそのまま表示できる
- Debug LogやModel/API由来のRaw出力は診断目的で英語を含む場合があるが、主要操作の理解をRaw Logへ依存させない

## アプリアイコン

Local AI Lab専用のアイコンを、小さいWindows表示でも判別できる形で使用します。

- 濃紺の角丸背景
- 太い青い `L`
- 右上にシアンの状態点
- 小サイズで潰れる文字・細線・波形は使わない

編集する正本は `desktop/assets/icon.svg` だけです。

`npm run icon:build` が次を自動生成します。

```text
16 / 24 / 32 / 48 / 64 / 128 / 256 / 512 px PNG
Windows用 multi-size icon.ico
```

Windows packageとTitlebarは `desktop/assets/generated/icon.ico`、非Windows Window用には生成済み `icon.png` を使用します。生成物はGit管理せず、Desktop起動前とWindows Build前に毎回生成します。

Windows配布では、コード署名を無効のままにしつつ `signAndEditExecutable: true` で実行ファイルのResource編集を有効にします。

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
前回のRepositoryを自動復元
↓
必要なときだけRepositoryを変更
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

最後に選んだRepositoryはElectron `userData` のSettingsへ自動保存します。次回起動時はそのPathをそのまま復元し、毎回Folder Pickerを表示しません。旧VersionでPathが空になっている場合は、保存済みRun履歴から最後に使った有効なRepository Pathを復元します。Folder Pickerは「変更」を押したときだけ使用します。

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
- 前回Repositoryの自動復元 / 必要時のRepository変更
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
- Model Profile / 最後に使ったRepositoryの設定保存
- Electron userDataへのRun履歴 / Settings / 最大100件の診断履歴
- GitHub Releases One-click Update
- 実行中だけ `prevent-app-suspension` を使うSleep防止
- 実行中Window Close時の中断確認
- Background完了 / Failure通知
- Single Instance Guard
- 履歴検索 / Run保存Folder Open
- 手動停止StateとProcess Tree停止
- 長時間LogのMain Output / Renderer DOM上限
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

Bonsai 2 27BはDesktopから起動・状態確認・停止できます。

初回だけ設定画面で `Bonsai-demo` Folderを指定します。User PCで既定の `D:\AI\Bonsai-demo` が存在する場合は自動候補として使います。

Desktopが実行する起動条件:

```text
BONSAI_CTX=16384
BONSAI_MMPROJ_CPU=1
BONSAI_SPECULATIVE=0
BONSAI_KV4=0

start_llama_server.ps1
  --alias bonsai-2-27b
  --parallel 1
  --reasoning-budget 1024
```

- 「Bonsaiを起動」でPowerShell Windowを表示せずBackground起動する
- 起動・停止はUserがButtonを押した場合だけ行い、Desktopの起動・終了では自動実行しない
- 「Bonsaiを停止」はDesktop自身が起動したProcessだけを対象にする
- 別PowerShellで起動済みなら「外部で起動中」と表示し、DesktopからKillしない
- Bonsai停止中の監査は開始前に止め、起動が必要であることを日本語で案内する

BonsaiのModel download、`setup.ps1`、PrismML Binary setupは自動化しません。すでにSetup済みのBonsai-demoをDesktopから管理する機能です。

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


## 長時間Runの保護

全体監査は数分〜数十分かかるため、DesktopはCommand実行中だけOSのApp Suspendを防止します。Display Sleepまで強制的に止めず、処理完了・Failure・手動停止時にProtectionを解除します。

実行中にWindowを閉じると確認Dialogを表示します。「停止して終了」を選んだ場合だけActive Command Process Treeを停止して終了します。Bonsai RuntimeのStart / Stop Contractは別管理で、Desktop終了を理由にBonsaiを自動停止しません。

AppがForegroundでないときはCommand完了 / FailureをOS Notificationで通知します。

同じAppを二重起動した場合は既存WindowをForegroundへ戻し、同一Settings / Run Storeを複数Instanceから同時操作しません。

## 履歴

履歴画面では実行ID、対象Folder、監査目的、Status等を検索できます。「保存先」から、safe Run IDで解決したそのRunの保存FolderだけをExplorerで開けます。Rendererから任意PathをShellへ渡すAPIは公開しません。
