// UserRepository (メモリアダプタ) の単体テスト。
// 監査で発見したギャップ: LINE 紐付け系の 4 メソッドは user-line-link.memory.test.ts で
// カバー済みだったが、findById/findByEmail/create (メール一意制約)・listAgents*/
// findSummariesByIds/listAgentEmails/listAdminEmails/countByTenant はテストが無かった。
// 特に countByTenant (Phase 4 課金のシート上限判定に使う) と listAdminEmails
// (trial-reminder の通知先取得に使う) はテナント分離を誤ると課金・通知の不具合に直結するため
// 重点的に検証する。

import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext, type Store } from '@/data/adapters/memory';
import type { Repos } from '@/data/ports/unit-of-work';

const TENANT = 'default-tenant';
const OTHER_TENANT = 'other-tenant';

let store: Store;
let repos: Repos;

// テスト用メンバーを 1 人ストアに置く小ヘルパー (user-line-link.memory.test.ts と同型)
function putUser(id: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const now = new Date();
  store.users.set(id, {
    id,
    email: `${id}@example.com`,
    name: id,
    passwordHash: 'x',
    role: 'requester',
    tenantId,
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
}

describe('UserRepository (memory)', () => {
  beforeEach(() => {
    const ctx = createMemoryContext();
    store = ctx.store;
    repos = ctx.repos;
  });

  // findById: 存在するユーザーを返し、破壊防止のため複製を返す (tenantId スコープなし)
  it('findByIdはIDで1件取得し、複製を返す (直接変更してもストアに影響しない)', async () => {
    putUser('u1', TENANT);
    const found = await repos.users.findById('u1');
    expect(found?.id).toBe('u1');
    // 返り値を書き換えてもストア本体には影響しないこと (防御的コピーの確認)
    if (found) found.name = '書き換え後';
    expect(store.users.get('u1')?.name).toBe('u1');
    // 存在しない ID は null
    expect(await repos.users.findById('no-such-user')).toBeNull();
  });

  // findByEmail: テナント横断で検索できる (ログインフロー用)
  it('findByEmailはテナントを横断してメールで検索する', async () => {
    putUser('u1', TENANT, { email: 'agent@example.com' });
    putUser('u2', OTHER_TENANT, { email: 'other@example.com' });
    // 別テナントのユーザーでもメール一致で見つかる (ログイン時点ではテナント未確定のため)
    expect((await repos.users.findByEmail('other@example.com'))?.id).toBe('u2');
    expect(await repos.users.findByEmail('nobody@example.com')).toBeNull();
  });

  // create: 新規ユーザーを作成できる
  it('createは新規ユーザーを作成しIDを採番する', async () => {
    const user = await repos.users.create({
      email: 'new@example.com',
      name: '新規太郎',
      passwordHash: 'hashed',
      role: 'requester',
      tenantId: TENANT,
    });
    expect(user.id).toBeTruthy();
    expect(user.email).toBe('new@example.com');
    expect(store.users.get(user.id)?.tenantId).toBe(TENANT);
  });

  // create: メール一意制約 (@unique) をテナント横断で強制する
  it('createは既存メールと重複するとテナントを問わず例外を投げる', async () => {
    putUser('u1', TENANT, { email: 'dup@example.com' });
    await expect(
      repos.users.create({
        email: 'dup@example.com',
        name: '別テナントの人',
        passwordHash: 'x',
        role: 'requester',
        tenantId: OTHER_TENANT,
      }),
    ).rejects.toThrow();
  });

  // listAgents: agent/admin のみを名前順で返し、requester と他テナントは除外する
  it('listAgentsはagent/adminのみを名前順で返す', async () => {
    putUser('u-req', TENANT, { role: 'requester', name: 'requester太郎' });
    putUser('u-agent-b', TENANT, { role: 'agent', name: 'ぶらぼー' });
    putUser('u-agent-a', TENANT, { role: 'admin', name: 'あいうえお' });
    putUser('u-other-tenant-agent', OTHER_TENANT, { role: 'agent', name: 'あ他テナント' });

    const agents = await repos.users.listAgents(TENANT);
    expect(agents.map((a) => a.id)).toEqual(['u-agent-a', 'u-agent-b']);
  });

  // listAgentIds: ID のみを返す (テナント分離込み)
  it('listAgentIdsはagent/adminのIDのみを返す', async () => {
    putUser('u-req', TENANT, { role: 'requester' });
    putUser('u-agent', TENANT, { role: 'agent' });
    putUser('u-other-tenant', OTHER_TENANT, { role: 'admin' });

    const ids = await repos.users.listAgentIds(TENANT);
    expect(ids).toEqual(['u-agent']);
  });

  // findSummariesByIds: 指定 ID かつ同テナントのユーザーのみ抽出する
  it('findSummariesByIdsは指定IDかつ同テナントのユーザーのみ返す', async () => {
    putUser('u1', TENANT, { name: 'ユーザー1' });
    putUser('u2', TENANT, { name: 'ユーザー2' });
    putUser('u3', OTHER_TENANT, { name: '別テナントのユーザー' });

    const summaries = await repos.users.findSummariesByIds(['u1', 'u3', 'no-such-id'], TENANT);
    // u3 は別テナントなので除外され、no-such-id は存在しないので除外される
    expect(summaries).toEqual([{ id: 'u1', name: 'ユーザー1' }]);
  });

  // listAgentEmails: agent/admin の id + email をテナントスコープで返す (一斉メール送信用)
  it('listAgentEmailsはagent/adminのid+emailを返す', async () => {
    putUser('u-req', TENANT, { role: 'requester', email: 'req@example.com' });
    putUser('u-agent', TENANT, { role: 'agent', email: 'agent@example.com' });
    putUser('u-other-tenant', OTHER_TENANT, { role: 'admin', email: 'other@example.com' });

    const emails = await repos.users.listAgentEmails(TENANT);
    expect(emails).toEqual([{ id: 'u-agent', email: 'agent@example.com' }]);
  });

  // listAdminEmails: admin のみ (agent は含まない) — trial-reminder 等の通知先取得に使う
  it('listAdminEmailsはadminのみを返しagentは含まない', async () => {
    putUser('u-agent', TENANT, { role: 'agent', email: 'agent@example.com' });
    putUser('u-admin', TENANT, { role: 'admin', email: 'admin@example.com' });
    putUser('u-other-tenant-admin', OTHER_TENANT, { role: 'admin', email: 'other@example.com' });

    const admins = await repos.users.listAdminEmails(TENANT);
    expect(admins).toEqual([{ id: 'u-admin', email: 'admin@example.com' }]);
  });

  // countByTenant: agent/admin のみをシート数としてカウントし、requester は含まない
  it('countByTenantはagent/adminのみを数えrequesterは含まない (シート上限判定用)', async () => {
    putUser('u-req-1', TENANT, { role: 'requester' });
    putUser('u-req-2', TENANT, { role: 'requester' });
    putUser('u-agent', TENANT, { role: 'agent' });
    putUser('u-admin', TENANT, { role: 'admin' });
    putUser('u-other-tenant-agent', OTHER_TENANT, { role: 'agent' });

    expect(await repos.users.countByTenant(TENANT)).toBe(2);
    expect(await repos.users.countByTenant(OTHER_TENANT)).toBe(1);
  });
});
