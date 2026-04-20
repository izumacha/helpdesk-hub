// Vitest のテスト DSL とモック機能
import { describe, expect, it, vi } from 'vitest';
// メモリ実装の通知ブロードキャスタ生成関数
import { createInMemoryNotificationBroadcaster } from '@/data/adapters/memory/notification-broadcaster.memory';
// SSE 送信先 (ストリームコントローラ) の型
import type { BroadcastController } from '@/data/ports/notification-broadcaster';

// テスト用の偽 ReadableStreamController (enqueue を spy にして検証する)
function fakeController(): BroadcastController & { enqueue: ReturnType<typeof vi.fn> } {
  return {
    // 送信される chunk を後で取り出せるように mock 化
    enqueue: vi.fn(),
    close: vi.fn(),
    error: vi.fn(),
    desiredSize: 1,
  } as unknown as BroadcastController & { enqueue: ReturnType<typeof vi.fn> };
}

// SSE chunk から count 値だけを抜き出すヘルパー
function decodeCount(chunk: unknown): number {
  // バイト列を文字列にデコード
  const text = new TextDecoder().decode(chunk as Uint8Array);
  // "data: { ... }" 部分を抽出
  const match = text.match(/data: (\{.*?\})/);
  if (!match) throw new Error(`no data payload in chunk: ${text}`);
  // JSON パースして count を取り出す
  return JSON.parse(match[1]).count as number;
}

// in-memory ブロードキャスタの仕様検証
describe('in-memory notification broadcaster', () => {
  // 同一ユーザーに紐づく全コントローラへ配信される (他ユーザーには届かない)
  it('delivers broadcasts to every open controller for the target user', () => {
    const broadcaster = createInMemoryNotificationBroadcaster();
    const ctrlA1 = fakeController();
    const ctrlA2 = fakeController();
    const ctrlB = fakeController();

    // user-a に 2 本、user-b に 1 本の購読を登録
    broadcaster.addSubscriber('user-a', ctrlA1);
    broadcaster.addSubscriber('user-a', ctrlA2);
    broadcaster.addSubscriber('user-b', ctrlB);

    // user-a 宛にカウント 3 を配信
    broadcaster.broadcast('user-a', 3);

    // user-a 側の 2 本にだけ enqueue が 1 回ずつ呼ばれる
    expect(ctrlA1.enqueue).toHaveBeenCalledTimes(1);
    expect(ctrlA2.enqueue).toHaveBeenCalledTimes(1);
    // user-b 側には配信されない
    expect(ctrlB.enqueue).not.toHaveBeenCalled();
    // 送信ペイロードは count=3
    expect(decodeCount(ctrlA1.enqueue.mock.calls[0][0])).toBe(3);
  });

  // 解除後のコントローラにはもう配信されない
  it('removes a controller on removeSubscriber', () => {
    const broadcaster = createInMemoryNotificationBroadcaster();
    const ctrl = fakeController();

    broadcaster.addSubscriber('user-a', ctrl);
    broadcaster.removeSubscriber('user-a', ctrl);
    broadcaster.broadcast('user-a', 1);

    expect(ctrl.enqueue).not.toHaveBeenCalled();
  });

  // 未登録ユーザー宛の配信は no-op (例外を投げない)
  it('is a no-op when broadcasting to an unknown user', () => {
    const broadcaster = createInMemoryNotificationBroadcaster();
    expect(() => broadcaster.broadcast('ghost', 5)).not.toThrow();
  });

  // 例外を投げる壊れたコントローラはサイレントに除外される
  it('silently drops a controller whose enqueue throws', () => {
    const broadcaster = createInMemoryNotificationBroadcaster();
    const healthy = fakeController();
    const broken = fakeController();
    // broken 側は enqueue で例外を投げる
    broken.enqueue.mockImplementation(() => {
      throw new Error('stream closed');
    });

    // 両方を user-a に紐づける
    broadcaster.addSubscriber('user-a', healthy);
    broadcaster.addSubscriber('user-a', broken);

    // 1 回目の配信: healthy にだけ届けば OK
    broadcaster.broadcast('user-a', 2);
    expect(healthy.enqueue).toHaveBeenCalledTimes(1);

    // broken 側のモック呼び出し履歴をクリア
    broken.enqueue.mockClear();
    // 2 回目: broken はもう除外されており、healthy にだけ届く
    broadcaster.broadcast('user-a', 4);
    expect(broken.enqueue).not.toHaveBeenCalled();
    expect(healthy.enqueue).toHaveBeenCalledTimes(2);
  });

  // 複数のブロードキャスタは状態を共有しない (生成ごとに独立)
  it('isolates state between independent broadcaster instances', () => {
    const a = createInMemoryNotificationBroadcaster();
    const b = createInMemoryNotificationBroadcaster();
    const ctrl = fakeController();

    // a 側にだけ購読登録し、b 側で配信しても届かないこと
    a.addSubscriber('user-a', ctrl);
    b.broadcast('user-a', 9);

    expect(ctrl.enqueue).not.toHaveBeenCalled();
  });
});
