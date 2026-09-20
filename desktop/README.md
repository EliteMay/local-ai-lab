# Local AI Lab Desktop v0.1

PowerShellで行っている local-ai-lab の日常操作を、Windows向けElectron GUIから実行するためのDesktop Controllerです。

## v0.1 Scope

- Runtime / Model Profile状態の確認
- Repository選択
- doctor
- inspect
- coverage
- coverage-synthesize
- npm test
- 実行Log表示
- Coverage進捗表示
- 結果のClipboard Copy
- runtime-data/runs の履歴表示
- Model Profile / Default Repositoryの設定保存

対象Repositoryへの自動修正、自由Shell、git commit / pushは提供しません。

## 起動

PowerShell:

    npm install
    npm run desktop

Electronの設定はElectron userData配下の settings.json に保存され、Project Repositoryの設定Fileは直接変更しません。

## Security Boundary

RendererではNode integrationを無効にし、context isolation / sandboxを有効にします。Sandboxed preloadはElectronの制約に合わせてCommonJS (`preload.cjs`) を使用します。Rendererから利用できるIPCはRepository選択、許可済みCommand実行、履歴読込、Clipboard、Desktop設定に限定します。

任意Shell文字列は受け付けず、CLI引数はMain Process側で組み立てます。

## Current Limitation

v0.1のModel Profile切替は「どのProfileでlocal-ai-labを実行するか」の切替です。LM Studio / PrismML runtime自体の起動、Model download、Load / Unloadはまだ自動化しません。
