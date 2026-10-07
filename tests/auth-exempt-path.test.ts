// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';

// 認証ガード対象外の判定に使う 2 つの純粋関数
import { isStrictlyUnderPath, isUnderPath } from '../src/lib/auth-exempt-path';

// src/proxy.ts が認証ガードの対象外を決めるのに使う述語。
// ここが緩むと「そのルートを足しただけで認証を一切通らない」状態になり、
// 差分にも何にも現れないので、退行をこのテーブルで固定する。
describe('auth-exempt-path', () => {
  describe('isUnderPath (接頭辞そのものを含む部分木)', () => {
    // 対象外にしたい実在の形 ＋ 対象外にしてはいけない紛らわしい形
    const cases: ReadonlyArray<[pathname: string, prefix: string, expected: boolean]> = [
      // 部分木の根そのもの (ヘルプのトップページ等。ここが漏れると根だけログインを要求される)
      ['/help', '/help', true],
      ['/login', '/login', true],
      // 部分木の中
      ['/help/getting-started', '/help', true],
      ['/invite/abc123', '/invite', true],
      ['/signup/complete', '/signup', true],
      ['/api/auth/callback/credentials', '/api/auth', true],
      // 末尾スラッシュだけの形も部分木の中として扱う
      ['/login/', '/login', true],
      // **セグメントの途中で一致してはいけない形**。素の startsWith だとすべて true になり、
      // そのルートを足した瞬間に認証ガードから静かに外れる
      ['/loginx', '/login', false],
      ['/helpdesk', '/help', false],
      ['/signupx', '/signup', false],
      ['/invitex', '/invite', false],
      ['/api/authz/admin', '/api/auth', false],
      ['/api/authz', '/api/auth', false],
      // 無関係なパス
      ['/dashboard', '/help', false],
      ['/api/tickets', '/api/auth', false],
    ];

    // 表の 1 行ずつを個別のテストとして流す
    it.each(cases)('isUnderPath(%s, %s) === %s', (pathname, prefix, expected) => {
      // 判定結果が表のとおりであること
      expect(isUnderPath(pathname, prefix)).toBe(expected);
    });
  });

  describe('isStrictlyUnderPath (接頭辞そのものを含まない)', () => {
    // 受信 Webhook 用。根を外さないことが要点
    const cases: ReadonlyArray<[pathname: string, prefix: string, expected: boolean]> = [
      // 実在する子は対象外にする (各自が共有シークレット / HMAC で自前に認可する)
      ['/api/inbound/email', '/api/inbound', true],
      ['/api/inbound/line', '/api/inbound', true],
      ['/api/webhooks/stripe', '/api/webhooks', true],
      // **根そのものは対象外にしない**。ここを true にすると、後から
      // src/app/api/inbound/route.ts を足したときに未認証で公開される
      ['/api/inbound', '/api/inbound', false],
      ['/api/webhooks', '/api/webhooks', false],
      // セグメントの途中で一致してはいけない形
      ['/api/inboundx', '/api/inbound', false],
      ['/api/inboundx/y', '/api/inbound', false],
      ['/api/webhooksx/stripe', '/api/webhooks', false],
    ];

    // 表の 1 行ずつを個別のテストとして流す
    it.each(cases)('isStrictlyUnderPath(%s, %s) === %s', (pathname, prefix, expected) => {
      // 判定結果が表のとおりであること
      expect(isStrictlyUnderPath(pathname, prefix)).toBe(expected);
    });
  });

  // 2 つの述語の違いが「根を含むかどうか」だけであることを明示的に固定する。
  // 片方をもう片方へ置き換える「整理」が入ったときに落ちる
  it('2 つの述語は根の扱いだけが異なる', () => {
    // 根: isUnderPath は含み、isStrictlyUnderPath は含まない
    expect(isUnderPath('/api/inbound', '/api/inbound')).toBe(true);
    expect(isStrictlyUnderPath('/api/inbound', '/api/inbound')).toBe(false);
    // 配下: どちらも true
    expect(isUnderPath('/api/inbound/email', '/api/inbound')).toBe(true);
    expect(isStrictlyUnderPath('/api/inbound/email', '/api/inbound')).toBe(true);
    // セグメント途中: どちらも false
    expect(isUnderPath('/api/inboundx', '/api/inbound')).toBe(false);
    expect(isStrictlyUnderPath('/api/inboundx', '/api/inbound')).toBe(false);
  });
});
