// 生成された Prisma クライアントの型 (DB 操作の窓口) をインポート
import type { PrismaClient } from '@/generated/prisma';
// ドライバアダプタ込みでクライアントを組み立てる共通ファクトリをインポート
import { createPrismaClient } from './prisma-client';

// PrismaClient が二重に作られないよう、グローバル変数を借りてプロセス内で 1 つに固定する。
//
// キャッシュが必要な理由は 2 つある (どちらも「同じプロセス内でこのモジュールが 2 回評価される」問題):
//   1. 開発時のホットリロード … 再評価のたびに新しいクライアントが積み上がる。
//   2. **proxy (`src/proxy.ts`) と app サーバーのバンドル分離 (issue #298)** … Next.js は
//      リクエスト入口 (proxy) を app サーバーとは別チャンクにバンドルするため、同一プロセス上に
//      モジュールレジストリが 2 つ存在する。`auth` の `jwt` コールバックは proxy 側から
//      Prisma を呼ぶので、globalThis を挟まないと**接続プールが 2 本**張られる。
//      プール数は node-postgres の既定で 1 プールあたり最大 10 接続なので、10 → 20 接続に
//      倍増し、Postgres の `max_connections` を圧迫する
//      (プール数を変えたいときは従来どおり接続文字列の `connection_limit` を使う。
//       ドライバアダプタ自身は解釈しないが、`createPrismaClient` が node-postgres の
//       `max` へ読み替えている。`pool_timeout` / `connect_timeout` も同様)。
//      枯渇すると `jwt` コールバックが接続待ちで失敗し、#298 で直したはずの
//      「ログイン中のユーザーが /login に弾かれる」に戻る。
//
// そのため **本番も含めて常に** globalThis にキャッシュする (下の代入に環境の条件を付けない)。
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined; // グローバルに保持する Prisma インスタンス (未定義の可能性あり)
};

// 実際に DB へ触るまでクライアントを作らないための遅延生成関数。
//
// Prisma 7 はドライバアダプタ必須になり、生成時点で接続文字列を要求する (未設定なら
// createPrismaClient が fail-closed で落ちる)。一方このモジュールは `@/data` 経由で
// **DB を触らないユニットテストからも import される**ため、モジュール評価と同時に
// クライアントを組み立てると DATABASE_URL 未設定の環境で import しただけで落ちる
// (ユニットテストに DB 依存を持ち込まないという CLAUDE.md §11 の境界が壊れる)。
// そこで生成を初回アクセスまで遅らせ、fail-closed の検査は「実際に使うとき」に効かせる。
function getPrismaClient(): PrismaClient {
  // 既に生成済みならそれを返す (globalThis キャッシュ: 上のコメントの理由で本番も含め常に使う)
  globalForPrisma.prisma ??= createPrismaClient({
    // 開発環境では error と warn を表示、本番では error のみに絞る
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });
  // キャッシュ済みのインスタンスを返す
  return globalForPrisma.prisma;
}

// bind し直したメソッドを覚えておく表 (クライアント実体 → プロパティ名 → 束ねた関数)。
// 毎回 bind すると `prisma.$transaction === prisma.$transaction` が false になり、
// 「登録したハンドラを同じ参照で解除する」(process.off / removeEventListener) が効かなくなる。
//
// **キーはクライアント実体**にする。`$transaction` などのメソッドはインスタンス間で
// 同一の関数オブジェクト (プロトタイプ上の 1 つ) なので、プロパティ名だけで覚えると
// globalThis のクライアントが差し替わっても「同じ関数だ」と判定してしまい、
// 破棄済みクライアントに束ねた古いメソッドを返し続ける。WeakMap なので古い
// クライアントが参照されなくなればエントリごと回収される。
const boundMethodsByClient = new WeakMap<
  PrismaClient,
  Map<PropertyKey, { source: unknown; bound: unknown }>
>();

// 既存の呼び出し側 (`prisma.ticket.findMany()` など) を変えずに遅延生成を挟むための Proxy。
// プロパティに触れた瞬間に初めて実クライアントを生成し、以降はキャッシュを使う。
// ターゲットは空オブジェクトなので、**転送できる操作はすべて実クライアントへ転送する**
// (get/has だけだと Object.keys() や代入が空のターゲット側に落ちて黙って食い違う)。
// 唯一転送できないのが「拡張の禁止」で、こちらは黙って食い違わないよう明示的に失敗させる
// (末尾の isExtensible / preventExtensions を参照)。
export const prisma = new Proxy({} as PrismaClient, {
  // プロパティ読み取り (prisma.ticket / prisma.$transaction など) を実クライアントへ委譲する
  get(_target, property) {
    // 実クライアントを取得する (初回のみ生成される)
    const client = getPrismaClient();
    // 目的のプロパティを取り出す。receiver は渡さない —
    // 渡すと getter の this が Proxy になり、実クライアント側の private フィールドを読めなくなる
    const value = Reflect.get(client, property);
    // 関数でなければそのまま返す (モデルデリゲートなどのオブジェクト)
    if (typeof value !== 'function') return value;
    // このクライアント用の表を取り出す (無ければ空の表を作って登録する)
    let boundMethods = boundMethodsByClient.get(client);
    if (!boundMethods) {
      boundMethods = new Map<PropertyKey, { source: unknown; bound: unknown }>();
      boundMethodsByClient.set(client, boundMethods);
    }
    // 同じクライアントの同じ関数を前回束ねていれば、その参照を使い回す (同一性を保つ)。
    // source も見るのは、テストがメソッドを差し替えたときに古い参照を返さないため。
    const cached = boundMethods.get(property);
    if (cached && cached.source === value) return cached.bound;
    // 初回、または差し替えられていたら this が実クライアントを指すように束ね直す
    const bound = value.bind(client);
    // 次回同じプロパティを読んだときに同じ参照を返せるよう覚えておく
    boundMethods.set(property, { source: value, bound });
    // 束ね直したメソッドを返す
    return bound;
  },
  // プロパティ代入 (テストで $transaction を差し替える等) を実クライアントへ反映する
  set(_target, property, value) {
    return Reflect.set(getPrismaClient(), property, value);
  },
  // `in` 演算子やプロパティ存在確認も実クライアントに合わせる
  has(_target, property) {
    return Reflect.has(getPrismaClient(), property);
  },
  // Object.keys() / スプレッド展開が空にならないよう、キー一覧も実クライアントから返す
  ownKeys(_target) {
    return Reflect.ownKeys(getPrismaClient());
  },
  // ownKeys と対で必要 (記述子を返せないとキー列挙が実際には空になる)
  getOwnPropertyDescriptor(_target, property) {
    // 実クライアント側の記述子を取得する
    const descriptor = Reflect.getOwnPropertyDescriptor(getPrismaClient(), property);
    // Proxy の不変条件を満たすため、存在するキーは configurable: true にして返す
    return descriptor ? { ...descriptor, configurable: true } : undefined;
  },
  // Object.defineProperty での定義も実クライアントへ届ける
  // (空のターゲットに落とすと get 側は実クライアントしか見ないので定義が黙って消える。
  //  vitest がプロパティを差し替えるときに使う経路)
  defineProperty(_target, property, descriptor) {
    return Reflect.defineProperty(getPrismaClient(), property, descriptor);
  },
  // Object.getPrototypeOf / instanceof が空ターゲット (素の Object) を見ないようにする。
  // これで Proxy 越しでも「実クライアントを直接触ったとき」と同じ判定結果になる
  // (Prisma 7 の生成クライアント自体が素のオブジェクトなので instanceof PrismaClient は
  //  どちらでも false。ここで揃えたいのは Proxy と実体の差が出ないこと)
  getPrototypeOf(_target) {
    return Reflect.getPrototypeOf(getPrismaClient());
  },
  // プロトタイプの差し替えも実クライアントへ転送する (空ターゲットに書くと黙って消えるため)。
  // 実クライアント自身も Prisma 側の Proxy なので、受け付けても反映しないことがある —
  // ここで揃えたいのは「Proxy 越しでも実体を直接触ったときと同じ結果になる」こと (実測で一致)
  setPrototypeOf(_target, prototype) {
    return Reflect.setPrototypeOf(getPrismaClient(), prototype);
  },
  // 拡張の可否は「常に拡張できる」で答える。
  // ownKeys が実クライアントのキーを返す以上、ターゲットだけを非拡張にすると
  // Proxy の不変条件に反して以降の Object.keys が TypeError になる。
  // そのため Object.freeze / preventExtensions は**成功させずに落とす** (下の trap が false を返す)。
  // 黙って食い違うより、その場で分かるほうがよい
  isExtensible() {
    return true;
  },
  // 凍結の要求は受け付けない (理由は上のコメント。false を返すと呼び出し側が TypeError になる)
  preventExtensions() {
    return false;
  },
  // delete 演算子も実クライアントへ転送する
  deleteProperty(_target, property) {
    return Reflect.deleteProperty(getPrismaClient(), property);
  },
});
