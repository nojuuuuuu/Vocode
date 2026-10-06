# 家計管理アプリ

収入・支出をローカルの SQLite データベースに保存する React アプリです。

## 起動

Node.js 22 以降で、このフォルダ内から実行します。

```sh
npm install
npm run dev
```

画面は <http://127.0.0.1:5173/>、API は `127.0.0.1:3001` で起動します。`npm run dev` で両方を起動します。

## データの場所

初回起動時に `data/money.sqlite` が自動作成されます。データはこの端末に保存され、Git には含めません。バックアップする場合はアプリを終了してから `data/money.sqlite` をコピーしてください。

保存先を変える場合は、起動時に `DATABASE_PATH` を指定します。

```sh
DATABASE_PATH=/保存先/money.sqlite npm run dev
```

この構成では外部のデータベースアカウントや API キーは不要です。
