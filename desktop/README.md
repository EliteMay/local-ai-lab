# Local AI Lab Desktop v0.2

Local AI Labの監査・再統合・検証Runを、Windows向けElectron GUIから開始・監視・再開するためのDesktop Controllerです。

## Primary Flow

```text
Runtime / Model状態確認
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

Command CardのクリックはTask選択だけを行い、その場では実行しません。実行は画面下部の明示Buttonから開始します。

## v0.2 Scope

- Runtime / Model Profile状態の確認
- Repository選択
- doctor
- inspect
- coverage
- coverage-synthesize
- npm test
- 実行Log表示
- Coverage Batch進捗表示
- 経過時間 / Batch平均からの概算残り時間
- Prompt / Completion / Reasoning Token集計
- runtime-data/runs の履歴表示
- PARTIAL Coverageの再開準備
- Coverage 100% + Synthesis失敗RunのSynthesis再開準備
- 結果のClipboard Copy
- Model Profile / Default Repositoryの設定保存
- Electron userDataへの最大100件のローカル診断履歴
- 診断履歴のCopy / Clear

対象Repositoryへの自動修正、自由Shell、git commit / pushは提供しません。

## 起動

PowerShell:

    npm install
    npm run desktop

Electron設定と開発診断はElectronの `userData` 配下へ保存し、Project Repositoryの設定Fileは暗黙に変更しません。

## Bonsai 2 27B

Bonsai Profileを使う場合、PrismML llama.cpp Serverは別Processとして起動しておく必要があります。

Desktop側で `ECONNREFUSED 127.0.0.1:8080` を検出した場合、Bonsai Runtimeが起動していないことをUser向けMessageとして表示します。

Desktop v0.2はRuntimeのStart / Stop自動化、Model download、Load / Unloadまでは行いません。

## Security Boundary

- Rendererは `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- Sandboxed preloadはCommonJS (`preload.cjs`)
- Main Process側で許可済みCommandだけを実行
- User入力をShell文字列へ連結せずspawn argumentとして分離
- IPC sender URLをMain Process側で検証
- Rendererの外部Navigation / new windowを拒否
- Rendererへrestrictive CSPを設定
- Clipboard payload / Goal / Run ID / Model ProfileをMain Process側でValidation
- Target RepositoryへのWrite Capabilityは追加しない

## Diagnostics

直近100件まで、次のような操作EventだけをElectron userDataへ保存します。

- Command開始
- Command完了
- Command失敗
- Command停止
- Settings保存

Prompt本文、Repository File本文、Token、Credential等は保存しません。

## Current Limitations

- LM Studio / PrismML Runtime自体の起動は自動化しない
- Model download / Load / Unloadは自動化しない
- 長時間ProcessはAppを閉じると継続管理できない
- 残り時間は完了済みBatchの平均から出す概算で、Planner / Reviewerの所要時間は正確に予測しない
- Windows実機での最終UI確認はRepository CIだけでは代替できない
