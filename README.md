# 青年部金沢地区の日程表

浄土真宗親鸞会 金沢支部 青年部金沢地区の行事日程を、インタラクティブなカレンダーとして公開しています。

## 公開URL

https://jdss-kanazawa.github.io/calendar/

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `index.html` | カレンダー本体（HTML・CSS・JSを1ファイルに内包） |
| `scripts/sync-notion.mjs` | Notion DBから日程データを取得し `index.html` を更新するスクリプト |
| `.github/workflows/sync-notion.yml` | 1時間ごとの自動同期および手動実行用GitHub Actionsワークフロー |
| `favicon.ico` | ブラウザのタブ用アイコン |
| `favicon.png` | 高解像度用アイコン（512px） |
| `apple-touch-icon.png` | iOSのホーム画面追加用アイコン（180px） |

## 仕様

- 単一ファイルの自己完結型。外部ライブラリへの依存なし
- 画面の向き・幅で表示を切替（幅640px未満＝リスト表示 / 640px以上＝カレンダー表示）
- 「分類」「対象」のラベルをクリックすると表示・非表示を切替できる
- 日時はすべて日本時間（JST）基準
- 3日以上の期間ものは、カレンダーのマス内に横帯で表示
- 初期表示月: 当月（毎月1日に自動切り替え）

## 更新手順（自動化）

GitHub Actions により、**毎時0分にNotion DBから自動同期**されます。
また、Notion更新後に即座に反映したい場合は、GitHubの「Actions」タブから手動で実行することも可能です。

### 初回セットアップ（GitHub Secrets）

GitHubリポジトリの **Settings > Secrets and variables > Actions** に以下を登録してください。

| Secret名 | 設定値 |
| --- | --- |
| `NOTION_API_KEY` | Notionインテグレーションのシークレットトークン（`ntn_...` または `secret_...`） |
| `NOTION_DATABASE_ID` | 日程表のDatabase ID（例: `2074219514d48027b9e6e1b6daed35d5`） |

※ GitHub Actions が変更をコミットしてプッシュできるよう、リポジトリの **Settings > Actions > General > Workflow permissions** で **「Read and write permissions」** にチェックを入れて保存してください。
