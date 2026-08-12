// 未読件数キャッシュの失効ヘルパーが「即時失効」で呼ばれることを固定する回帰テスト。
//
// なぜこのテストが要るか: Next.js 16 の `revalidateTag(tag, profile)` は、プロファイルを
// 渡すと stale-while-revalidate 扱いになり「そのパスは再検証済み」という印が付かない。
// つまり Server Action が自分の書き込みを読み返せず、既読化した直後に未読バッジが
// 古い件数のまま残る。`{ expire: 0 }` だけが即時失効として扱われる。
// この差は型検査を通ってしまう (どちらも合法な引数) ため、機械的に固定しておく。

// Vitest のテスト API を読み込む
import { beforeEach, describe, expect, it, vi } from 'vitest';

// unstable_cache に渡されたオプション (tags など) を記録しておく箱。
// キャッシュを「作る側」が登録するタグを観測して、「消す側」のタグと一致するか検証する
const unstableCacheOptions: Array<{ tags?: string[]; revalidate?: number }> = [];

// next/cache をモックする (実際のキャッシュ機構は起動せず、呼ばれ方だけを観測する)
vi.mock('next/cache', () => ({
  // タグ単位の無効化 API。引数を記録するだけのスパイに差し替える
  revalidateTag: vi.fn(),
  // unstable_cache は第 3 引数 (tags/revalidate) を記録したうえで、渡された関数を素通しさせる
  unstable_cache: (
    fn: unknown,
    _keys: string[],
    options: { tags?: string[]; revalidate?: number },
  ) => {
    // 生成側が登録したタグを後で照合できるよう控える
    unstableCacheOptions.push(options);
    // キャッシュを挟まずそのまま返す (このテストの関心はタグ文字列だけ)
    return fn;
  },
}));

// データ層 (@/data) をモックする。**これが無いと本物の PrismaClient を生成してしまう**:
// @/lib/notifications → @/data → @/lib/prisma の連鎖で、gitignore 対象の生成物
// (src/generated/prisma) をまだ作っていない fresh clone では import 解決に失敗し、
// このファイルだけが `npm run test` を落とす。ユニットテストに DB を持ち込まない方針
// (CLAUDE.md §3 テスト / §11) にも合わせて、他の 52 ファイルと同じくモックで断ち切る
vi.mock('@/data', () => ({
  // 未読件数の実カウントはこのテストでは呼ばないので、空の束で足りる
  repos: { notifications: { countUnread: vi.fn() } },
}));

// モック済みの next/cache から revalidateTag を取り出す (呼ばれ方を検証するため)
import { revalidateTag } from 'next/cache';
// 検証対象のヘルパー (失効側と生成側の両方を突き合わせる)
import { expireUnreadCountCache, getUnreadNotificationCount } from '@/lib/notifications';

describe('expireUnreadCountCache', () => {
  // 各テストの前にスパイと記録を消す (前のテストの呼び出しが混ざらないようにする)
  beforeEach(() => {
    vi.mocked(revalidateTag).mockClear();
    // 生成側のオプション記録も空に戻す
    unstableCacheOptions.length = 0;
  });

  it('ユーザー ID から組み立てたタグを 1 回だけ失効させる', () => {
    // 対象ユーザーのキャッシュ失効を実行する
    expireUnreadCountCache('user-123');
    // 呼び出しは 1 回だけ (取りこぼしも二重呼び出しも無いこと)
    expect(vi.mocked(revalidateTag)).toHaveBeenCalledTimes(1);
    // 第 1 引数がユーザーごとのタグであること (他人の件数を巻き込んで消さない)
    expect(vi.mocked(revalidateTag).mock.calls[0][0]).toBe('notification-count-user-123');
  });

  it('stale-while-revalidate ではなく即時失効 ({ expire: 0 }) を指定する', () => {
    // 対象ユーザーのキャッシュ失効を実行する
    expireUnreadCountCache('user-123');
    // 第 2 引数が即時失効を意味する { expire: 0 } であること。
    // ここを 'max' などのプロファイル名に変えると read-your-own-writes が効かなくなり、
    // 既読化直後に古い未読件数が残る。その退行をこの 1 行で止める
    expect(vi.mocked(revalidateTag).mock.calls[0][1]).toEqual({ expire: 0 });
  });

  it('ユーザーごとに異なるタグを使う', () => {
    // 2 人分のキャッシュを続けて失効させる
    expireUnreadCountCache('alice');
    expireUnreadCountCache('bob');
    // それぞれのタグが別物であること (タグ組み立てがユーザー ID を実際に使っている証明)
    expect(vi.mocked(revalidateTag).mock.calls[0][0]).toBe('notification-count-alice');
    expect(vi.mocked(revalidateTag).mock.calls[1][0]).toBe('notification-count-bob');
  });

  it('キャッシュを作る側と消す側が同じタグを使う', () => {
    // 生成側: 未読件数の取得を 1 回走らせ、unstable_cache に登録されたタグを記録させる
    void getUnreadNotificationCount('user-123', 'tenant-1');
    // 失効側: 同じユーザーのキャッシュを消す
    expireUnreadCountCache('user-123');
    // 両者のタグが一致すること。**これが本ヘルパー抽出の目的そのもの**で、
    // 片方だけ書き換えると無効化が空振りし、未読バッジが最大 60 秒古いまま残る。
    // 失効側だけを検証していると、この取り違えを素通ししてしまう
    expect(unstableCacheOptions[0]?.tags).toEqual([vi.mocked(revalidateTag).mock.calls[0][0]]);
  });
});
