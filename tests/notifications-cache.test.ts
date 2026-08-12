// 未読件数キャッシュの失効ヘルパーが「即時失効」で呼ばれることを固定する回帰テスト。
//
// なぜこのテストが要るか: Next.js 16 の `revalidateTag(tag, profile)` は、プロファイルを
// 渡すと stale-while-revalidate 扱いになり「そのパスは再検証済み」という印が付かない。
// つまり Server Action が自分の書き込みを読み返せず、既読化した直後に未読バッジが
// 古い件数のまま残る。`{ expire: 0 }` だけが即時失効として扱われる。
// この差は型検査を通ってしまう (どちらも合法な引数) ため、機械的に固定しておく。

// Vitest のテスト API を読み込む
import { beforeEach, describe, expect, it, vi } from 'vitest';

// next/cache をモックする (実際のキャッシュ機構は起動せず、呼ばれ方だけを観測する)
vi.mock('next/cache', () => ({
  // タグ単位の無効化 API。引数を記録するだけのスパイに差し替える
  revalidateTag: vi.fn(),
  // unstable_cache は「渡された関数をそのまま返す」形にして素通しさせる
  unstable_cache: (fn: unknown) => fn,
}));

// モック済みの next/cache から revalidateTag を取り出す (呼ばれ方を検証するため)
import { revalidateTag } from 'next/cache';
// 検証対象のヘルパー
import { expireUnreadCountCache } from '@/lib/notifications';

describe('expireUnreadCountCache', () => {
  // 各テストの前にスパイの記録を消す (前のテストの呼び出しが混ざらないようにする)
  beforeEach(() => {
    vi.mocked(revalidateTag).mockClear();
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
});
