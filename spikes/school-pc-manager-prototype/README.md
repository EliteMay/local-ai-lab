# Kaito PC Agent - School PC Prototype

これは学校PCで **方式そのものが動くかだけを確認する捨て検証版** です。

## この版が行うこと

- .NET 8 self-contained WinForms アプリが起動できるか確認
- Supabase Auth health endpoint への HTTPS 到達確認
- OAuth Readonly Gateway への到達確認
  - 未認証で 401/403 が返れば「Gateway到達 + OAuth保護あり」と判定
- Windows Named Pipe (`CurrentUserOnly`) の自己テスト
- 同じ exe から安全な Dummy Agent 子プロセスを起動
- Dummy Agent ↔ Manager の Named Pipe Heartbeat 確認
- 診断結果をクリップボードへコピー

## この版が絶対に行わないこと

- 本物の Kaito PC Agent コマンド実行
- ファイルの作成・編集・削除
- PowerShell / cmd / 任意コマンド実行
- Windows Startup 登録
- レジストリ変更
- サービス登録
- 管理者権限要求
- Device Token / OAuth Token の保存

## 学校PCでのテスト順

1. `KaitoPcAgentPrototype.exe` を起動
2. Windows の警告や学校の実行制限が出るか確認
3. `接続テスト`
4. `IPC自己テスト`
5. `Dummy Agent 起動`
6. Heartbeat が 2 秒ごとに更新されるか確認
7. `Dummy Agent 停止`
8. `診断結果をコピー`
9. 結果を ChatGPT に貼る

## 成功判定

最低限、次が成立すれば方式として有望です。

- exe が管理者権限なしで起動する
- Supabase へ HTTPS 到達できる
- OAuth Gateway が 401/403 を返して到達確認できる
- Named Pipe 自己テストが成功する
- Dummy Agent の子プロセス起動と Heartbeat が成功する

学校のポリシーで exe 実行・子プロセス生成・Named Pipe・外部 HTTPS のどこかが禁止される場合、その地点を診断結果から切り分けます。

## 注意

これは本番コードではありません。検証後にそのまま本番 Manager として採用する前提ではありません。
