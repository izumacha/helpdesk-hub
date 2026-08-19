// Prisma 7 の設定ファイル。Prisma 7 から datasource の接続 URL は
// schema.prisma に書けなくなり (P1012)、CLI 用の接続情報はここへ集約する。
// 参照: https://pris.ly/d/config-datasource
// defineConfig で型付きの設定を作る関数と、環境変数を読む env ヘルパーをインポート
import { defineConfig, env } from 'prisma/config';

// Prisma CLI (generate / migrate / db seed) が読み込む設定を既定エクスポートする
export default defineConfig({
  // スキーマファイルの場所 (Prisma 7 では既定探索に頼らず明示する)
  schema: 'prisma/schema.prisma',
  // migrate / introspect が使う接続先。アプリ実行時の接続は
  // src/lib/prisma-client.ts のドライバアダプタ側が担当する (ここは CLI 専用)
  datasource: {
    url: env('DATABASE_URL'),
  },
  // マイグレーション関連の設定
  migrations: {
    // `prisma db seed` が実行するコマンド (Prisma 7 で package.json の "prisma".seed から移設)
    seed: 'tsx prisma/seed.ts',
  },
});
