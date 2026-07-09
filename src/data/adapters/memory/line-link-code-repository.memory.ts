// LINE 連携コード冪等化記録リポジトリの契約 (port)
import type { LineLinkCodeRepository } from '@/data/ports/line-link-code-repository';
// メモリストア型
import type { Store } from './store';

// メモリストアを使った LineLinkCodeRef リポジトリを生成する関数 (テスト用)
export function makeLineLinkCodeRepo(store: Store): LineLinkCodeRepository {
  return {
    // messageId が既に連携コードとして処理済みかを判定する
    async wasProcessed(messageId) {
      return store.lineLinkCodeRefs.has(messageId);
    },

    // messageId を処理済みとして記録する (Set への追加は既に冪等)
    async markProcessed(messageId) {
      store.lineLinkCodeRefs.add(messageId);
    },
  };
}
