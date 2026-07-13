// Webhook (LINE / メール取り込み) の再送 (at-least-once) に対して冪等にチケットを起票する
// 共通ヘルパー。LINE (lineMessages) とメール (emailThreads) は対応表の Port 形状が
// 微妙に異なる (findTicketIdByMessageId は単数キー、findTicketIdByMessageIds は配列キー、
// register のフィールド名も lineMessageId / messageId で異なる) ため、その差異だけを
// IdempotencyOps で吸収し、冪等化の本体ロジックは 1 か所にまとめる。
//
// なぜ冪等化が必要か: Webhook プロバイダは応答が遅延/未受信だと同一メッセージ/メールを
// 再送する (at-least-once)。「対応表を SELECT → 無ければ起票 → 対応表へ INSERT」を
// 別々の呼び出しで行うと、再送が完全に同時に届いた場合、両方が「未処理」を読み取った
// まま起票してしまい二重起票の窓 (TOCTOU) が生まれる。
// ここでは SELECT → 起票 → 対応表登録を 1 つの Serializable トランザクションにまとめる。
// Serializable なら DB 側が競合を検知し、後勝ちのトランザクションを書き込み競合エラーで
// 中断するため、両方が「未処理」を読み取ったまま起票してしまうことがなくなる。
// 中断されたリクエストは (勝った方が確定させた) 対応表を読み直して重複として扱う。

// データ層の Composition Root (非トランザクション用の repos と、トランザクション境界の uow)
import { repos, uow } from '@/data';
// リポジトリ束の型 (トランザクション内の tx / 非トランザクションの repos 共通の型)
import type { Repos } from '@/data/ports/unit-of-work';
// チケット作成の入力型
import type { CreateTicketInput } from '@/data/ports/ticket-repository';

// チャネル (LINE / メール) ごとの対応表操作を抽象化した契約。
// tx は「トランザクション内の repos」または (競合後の再確認時は) 「通常の repos」のどちらも渡せる
// (どちらも Repos 型を満たすため呼び出し側で区別なく使える)。
export interface IdempotencyOps {
  // 冪等キーからチケット ID を逆引きする。未処理なら null
  findExisting(tx: Repos, key: string, tenantId: string): Promise<string | null>;
  // 冪等キーとチケットの対応を対応表へ登録する
  register(tx: Repos, key: string, ticketId: string, tenantId: string): Promise<void>;
}

// フォローアップ (2026-07-13): メール取り込みの添付ファイル対応で、チケット起票と添付メタ INSERT を
// 同一トランザクションで原子的に行う必要が生じたため、起票確定直後に追加の副作用を差し込めるフックを
// 用意する。汎用的なフック名にしているのは、LINE 取り込み等の他チャネルが将来同様の需要を持った際も
// この仕組みを再利用できるようにするため (添付専用の名前にしない)。
export interface CreateTicketIdempotentOptions {
  // チケット起票確定後、同一トランザクション内 (冪等化キーが無い場合は非トランザクションの repos) で
  // 実行する追加の副作用。ストレージ書き込みのような非トランザクション I/O をここで行う場合、
  // 失敗時の後始末 (書き込み済みファイルの削除等) は呼び出し側の責務とする
  // (uow は DB 書き込みをロールバックするだけで、既にストレージへ書き込み済みのファイルは削除しない)。
  onCreated?: (tx: Repos, ticketId: string) => Promise<void>;
}

// 冪等性を保ったままチケットを起票する。
export async function createTicketIdempotent(
  ops: IdempotencyOps, // チャネル固有の対応表操作 (LINE/メールで異なる Port 呼び分け)
  key: string | null, // 冪等化キー。取れなかった場合は null (冪等化なしで単発起票)
  tenantId: string,
  ticketInput: CreateTicketInput,
  options?: CreateTicketIdempotentOptions,
): Promise<{ id: string; alreadyExisted: boolean }> {
  // キーが取れないイベント/メールは突き合わせようがないため、従来どおり単発で起票する。
  // /code-review ultra 指摘対応 (2026-07-13): 以前は tickets.create と onCreated (添付メタ INSERT 等)
  // が別々の非トランザクション呼び出しだったため、チケット作成が確定した後に onCreated が失敗すると
  // 「チケットは残るが添付だけ無い中途半端な状態」で例外が伝播し、呼び出し元が 500 を返して
  // Webhook プロバイダが再送すると (このキー無し経路には重複検知が無いため) 別の重複チケットが
  // できてしまっていた。両方を 1 トランザクションにまとめ、どちらかが失敗すれば両方ロールバック
  // されるようにする (キーが無いため Serializable による競合検知は不要で、既定の分離レベルでよい)
  if (!key) {
    const created = await uow.run(async (tx) => {
      const t = await tx.tickets.create(ticketInput);
      if (options?.onCreated) await options.onCreated(tx, t.id);
      return t;
    });
    return { id: created.id, alreadyExisted: false };
  }

  try {
    return await uow.run(
      async (tx) => {
        // トランザクション内で再確認する (外側の事前チェックから開始までの間に、
        // 別リクエストが処理を終えている可能性があるため)
        const already = await ops.findExisting(tx, key, tenantId);
        if (already) return { id: already, alreadyExisted: true };
        // 起票してから対応表に登録する (同一トランザクション内なので原子的)
        const created = await tx.tickets.create(ticketInput);
        await ops.register(tx, key, created.id, tenantId);
        // 起票確定後の追加副作用 (添付メタ INSERT 等) を同一トランザクション内で実行する。
        // 重複判定 (already) で早期 return したケースでは呼ばない (別リクエストが既に処理済みのため)
        if (options?.onCreated) await options.onCreated(tx, created.id);
        return { id: created.id, alreadyExisted: false };
      },
      { isolationLevel: 'Serializable' },
    );
  } catch (err) {
    // 書き込み競合 = 同時に処理された同一メッセージ/メールの別リクエストが先に確定したということ。
    // 確定後の対応表を読み直せば、そちらが登録したチケット ID が見つかるはずなので重複扱いにする
    if (uow.isTransactionConflict(err)) {
      const winnerTicketId = await ops.findExisting(repos, key, tenantId);
      if (winnerTicketId) {
        return { id: winnerTicketId, alreadyExisted: true };
      }
    }
    // 書き込み競合以外、または競合なのに対応表が見つからない (想定外) 場合はそのまま伝播する
    throw err;
  }
}

// LINE メッセージ ID を冪等キーとする実装 (src/app/api/inbound/line/route.ts で使用)
export const lineMessageIdempotencyOps: IdempotencyOps = {
  findExisting: (tx, key, tenantId) => tx.lineMessages.findTicketIdByMessageId(key, tenantId),
  register: (tx, key, ticketId, tenantId) =>
    tx.lineMessages.register({ lineMessageId: key, ticketId, tenantId }),
};

// メール Message-ID を冪等キーとする実装 (src/app/api/inbound/email/route.ts で使用)
export const emailMessageIdempotencyOps: IdempotencyOps = {
  findExisting: (tx, key, tenantId) => tx.emailThreads.findTicketIdByMessageIds([key], tenantId),
  register: (tx, key, ticketId, tenantId) =>
    tx.emailThreads.register({ messageId: key, ticketId, tenantId }),
};
