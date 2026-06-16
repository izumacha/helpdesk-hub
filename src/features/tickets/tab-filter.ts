// 一覧タブ ('all' / 'mine' / 'overdue') の識別子型を再利用する (型のみ import なので client 境界の影響なし)
import type { TicketTabId } from './components/TicketTabs';
// データ層が公開しているチケット一覧フィルタ型 (タブ条件を差し込む対象)
import type { TicketListFilter } from '@/data/ports/ticket-repository';

// タブ条件を適用するときに必要な実行コンテキスト
// - isAgent: 担当者 (agent/admin) なら true。'mine' タブの絞り込み方が依頼者と変わる
// - userId : ログインユーザー ID。'mine' タブで「自分が担当」の判定に使う
// - now    : 現在時刻。'overdue' タブの期限超過判定の基準
interface TabFilterContext {
  isAgent: boolean;
  userId: string;
  now: Date;
}

// 一覧タブの絞り込み条件を、共通の真実の源として 1 か所に集約する純粋関数。
// 渡された base フィルタにタブ固有の条件を「追加」して返す (破壊的に書き換えず複製を返す)。
// 一覧ページ (/tickets) と Lite ダッシュボードの両方から呼び、タブの意味を二重定義しない。
// - 'all'    : 追加条件なし (base をそのまま使う)
// - 'mine'   : 「自分の未対応」= ステータスが Open または InProgress。
//              担当者は「担当が自分」のものに限定する (依頼者は base の creatorId で既に自分のチケットに絞られている)
// - 'overdue': 「期限切れ」= 解決期限を過ぎた未解決チケット (now を基準に判定)
export function applyTabFilter(
  base: TicketListFilter,
  tab: TicketTabId,
  ctx: TabFilterContext,
): TicketListFilter {
  // base を直接書き換えないよう浅いコピーを作る (呼び出し側の filter を汚さない)
  const filter: TicketListFilter = { ...base };
  // 'mine' タブ: 未対応 (Open / InProgress) かつ担当者なら自分が担当のもの
  if (tab === 'mine') {
    // ステータスを未対応の 2 値に限定する
    filter.statusIn = ['Open', 'InProgress'];
    // 担当者ロールのときだけ「担当が自分」を追加 (依頼者は creatorId で既に絞られている)
    if (ctx.isAgent) {
      filter.assigneeId = ctx.userId;
    }
  } else if (tab === 'overdue') {
    // 'overdue' タブ: 現在時刻基準で期限超過 + 未解決のみ
    filter.overdue = { now: ctx.now };
  }
  // タブ条件を反映したフィルタを返す
  return filter;
}
