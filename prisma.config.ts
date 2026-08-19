// Prisma 7 の設定ファイル。Prisma 7 から datasource の接続 URL は
// schema.prisma に書けなくなり (P1012)、CLI 用の接続情報はここへ集約する。
// 参照: https://pris.ly/d/config-datasource
// .env を読み込む副作用付き import。Prisma 7 の CLI は schema.prisma の env() を
// 解決していた頃と違い、この設定ファイルの評価時に .env を自動で読まない。
// README / CLAUDE.md が案内する `cp .env.example .env` のローカル手順を
// 従来どおり動かすため、ここで明示的に読み込む。
import 'dotenv/config';
// defineConfig で型付きの設定を作る関数をインポート
import { defineConfig } from 'prisma/config';

// CLI が使う接続先。migrate / db seed のときだけ必要になる
const databaseUrl = process.env.DATABASE_URL;

// Prisma CLI (generate / migrate / db seed) が読み込む設定を既定エクスポートする
export default defineConfig({
  // スキーマファイルの場所 (Prisma 7 では既定探索に頼らず明示する)
  schema: 'prisma/schema.prisma',
  // datasource は「値があるときだけ」載せる。prisma/config の env() は評価時に
  // 即解決して未設定なら例外を投げるため、素朴に書くと DB を必要としない
  // `prisma generate` まで巻き添えで落ちる (CI の lint ジョブと Dockerfile の
  // builder ステージはどちらも DATABASE_URL を持たない)。
  // 未設定のまま migrate / seed を叩いた場合は Prisma CLI 自身が接続先未指定として
  // 落ちるので、fail-closed は維持される。
  ...(databaseUrl ? { datasource: { url: databaseUrl } } : {}),
  // マイグレーション関連の設定
  migrations: {
    // `prisma db seed` が実行するコマンド (Prisma 7 で package.json の "prisma".seed から移設)
    seed: 'tsx prisma/seed.ts',
  },
});
