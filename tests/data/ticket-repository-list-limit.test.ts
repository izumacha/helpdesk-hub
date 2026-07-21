// resolveTicketListLimit (呼び出し元の指定値をクランプする純粋関数) の単体テスト。
//
// フォローアップ (2026-07-21): 監査で発見したギャップ。FaqRepository / LocationRepository /
// CategoryRepository / UserRepository / NotificationRepository はいずれもアダプタ層で
// 呼び出し元の limit をクランプする多層防御 (§8) を備えているが、最も中心的な TicketRepository
// だけこれが無かった。resolveFaqListLimit 等と同じ「アダプタ経由ではなく関数自体を直接テストする」
// 方針を踏襲する (実データを大量投入する統合テストにすると Prisma 契約テストが極端に重くなるため)。

import { describe, expect, it } from 'vitest';
import { TICKET_LIST_MAX_LIMIT, resolveTicketListLimit } from '@/data/ports/ticket-repository';

describe('resolveTicketListLimit', () => {
  // TICKET_LIST_MAX_LIMIT 以下ならそのまま返す
  it('TICKET_LIST_MAX_LIMIT以下ならそのまま返す', () => {
    expect(resolveTicketListLimit(20)).toBe(20);
    expect(resolveTicketListLimit(TICKET_LIST_MAX_LIMIT)).toBe(TICKET_LIST_MAX_LIMIT);
  });

  // TICKET_LIST_MAX_LIMIT を超えるとクランプされる
  it('TICKET_LIST_MAX_LIMITを超えるとクランプされる', () => {
    expect(resolveTicketListLimit(TICKET_LIST_MAX_LIMIT + 1)).toBe(TICKET_LIST_MAX_LIMIT);
    expect(resolveTicketListLimit(1_000_000)).toBe(TICKET_LIST_MAX_LIMIT);
  });
});
