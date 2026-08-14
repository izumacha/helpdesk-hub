// Next.js 設定ファイルの型 (補完と型安全のため)
import type { NextConfig } from 'next';

// 入口 (proxy) でボディを複製・バッファするときの上限 (経路別上限の最大 51MB ＋ 余白 1MB)。
// 余白は「経路の上限を踏み越えたこと」をルート側に観測させるためのもの (これが無いと
// chunked 転送の超過が 413 ではなく 400 になる)。導出は `src/lib/entry-body-limit.ts`。
//
// **未設定だと既定 10MB で本文が黙って切り詰められる** (エラーにならず、ルートハンドラが
// 欠けた本文を完全な本文として受け取る)。本リポジトリにはメール取り込み (25MB)・添付付きの
// チケット書き込み (51MB) という 10MB 超の経路があるため、その最大値まで広げる。
// 経緯・実測・メモリの見積もりは `src/lib/entry-body-limit.ts` を参照。
//
// **なぜ `ENTRY_MAX_BODY_BYTES` を import せず数値で書くのか**: next.config.ts は Next.js が
// 独自に transpile して `require` するが、その際 tsconfig の `paths` を書き換えるのは
// **この 1 ファイルの import だけ**で、そこから先に読み込まれるモジュールの `@/...` は
// 解決されない (実測: `Cannot find module './src/lib/webhook-body-limits'` でビルドが失敗する)。
// 経路別上限からの導出は `src/lib/entry-body-limit.ts` に残し、ここに書き写した値との一致は
// `tests/entry-body-limit.test.ts` が機械的に固定する (片方だけ変えたら CI で落ちる)。
const ENTRY_MAX_BODY_BYTES = 52 * 1024 * 1024;

// Next.js のビルド/実行時の挙動を切り替える設定オブジェクト
const nextConfig: NextConfig = {
  // standalone: 必要最小限のサーバ + 依存だけをまとめた出力 (Docker 配布用)
  output: 'standalone',
  experimental: {
    // 入口でのボディ複製の上限 (上のコメントの理由で明示的に設定する)
    proxyClientMaxBodySize: ENTRY_MAX_BODY_BYTES,
  },
};

// Next.js が読み取れるよう default export
export default nextConfig;
