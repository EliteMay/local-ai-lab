# Local AI Lab：家PCでの原因確認（読み取り専用）

更新日：2026-10-13

## 目的

GitHubの過去の実機記録では、Qwen3-8Bの長時間生成、JSON出力上限、Context上限、Bonsai 27Bの通信切断が発生した。複数は後で修正されているため、**現在のPCで再発するかは未確認**。

最初は既存Runの状態・モデル別の処理時間・失敗原因を整理する。診断が済むまで新しいモデル、MCP、AIチーム機能は増やさない。

## 帰宅後の手順

1. Windows PCを起動。Local AI Lab / AI Hubの既存Run履歴を残す。接続可能ならChatGPTからPCの読み取り操作を実行できる。
2. `EliteMay/local-ai-lab` の最新`main`を確認。Gitの未保存変更がある場合は上書きせず停止する。
3. Local AI LabのRepositoryで以下の**読み取り専用コマンド**を実行する。モデル起動や推論、git操作、ファイル書込みはしない。

   ```powershell
   npm run diagnose
   ```

   履歴10件を確認：

   ```powershell
   npm run diagnose -- --limit 10
   ```

4. 結果が`runs_directory_not_found`や`no_run_records`なら、実際の履歴保存先を指定する。CLI/開発版は`runtime-data/runs`、インストール版はElectronの`userData/runtime-data/runs`、AI Hub内ではHostのData Root配下の`runtime-data/runs`。アプリ履歴画面の「保存フォルダを開く」でRunフォルダを特定し、**1つ上のrunsフォルダ**を指定する。

   ```powershell
   npm run diagnose -- --runs-root "C:\実際の保存先\runtime-data\runs" --limit 10
   ```

5. 結果で`PARTIAL`、`output_limit`、`context_limit`、`timeout`、モデル別`failures`、Evidence行位置異常を確認する。必要な場合のみ小規模な代表Repositoryで実AIの比較をする。
6. PCが接続されたら、ChatGPT側でPC実行・実測結果を確認する。**現在は家PCで未検証**。

## 診断の意味と限界

| 項目 | 判断できること | 判断できないこと |
|---|---|---|
| Coverageと失敗Batch | 対象Chunkが処理されたか | バグの網羅的発見 |
| Model calls/token/時間 | 実行されたモデルの負荷傾向 | モデル間の公平な比較 |
| Output/Context/Timeout分類 | 保存済み失敗ログの傾向 | 全失敗の完全な原因 |
| Evidence行番号 | 保存済みCoverage Plan内の位置か | 指摘内容の真偽 |
| Reviewer結果 | 最終AIの判断 | 独立した正誤検証 |

**最優先は、同じRepositoryの既知の正解がある問題で、モデルが正しい指摘をできるか測ること。**

その際は条件を固定（Repository Snapshot、Goal、モデル、設定、`--reuse-coverage false`）。真陽性・誤検出・処理時間・失敗率を分けて記録する。モデルの数や役職を増やすのはその後。

## 安全な診断範囲

- `scripts/audit-diagnostics.mjs`はJSON履歴を読むだけ。生のソース、プロンプト、モデル回答、エラーメッセージ、ファイルの実パスを出力しない。
- 既存の`.backup`は読み取りのみで、壊れたファイルを復元・上書きしない。
- 実際のRun JSONや生ログは**GitHubへCommitしない**。必要な結果だけ確認して共有する。
- 診断結果がなくても勝手に再実行しない（モデル起動・長時間実験には明示的な次工程が必要）。

参考：`docs/ai-company-v1.1-research.md`、`docs/ai-company-v1.2-research.md`、`PROJECT_LEARNINGS.md`。
