// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';
// テスト対象 (純粋ヘルパー)
import {
  buildMagicLinkUrl,
  generateMagicLinkToken,
  hashMagicLinkToken,
  renderMagicLinkEmail,
  timingSafeHashEqual,
  MAGIC_LINK_TTL_MS,
} from '@/lib/magic-link';

describe('generateMagicLinkToken', () => {
  // 生成されたトークンは URL に直接入れられる base64url 文字列であること
  it('base64url 文字 (英数 + - + _) のみで構成される', () => {
    const t = generateMagicLinkToken();
    // 1 度の生成で十分な長さ (32 byte 相当) が出ていること
    expect(t.length).toBeGreaterThanOrEqual(40);
    // 想定外の文字 (= や / 等) が混じっていないこと
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  // 連続呼び出しでも同じ値が出ないこと (衝突確率は天文学的低さなので 2 回で十分)
  it('連続生成で同じ値にならない', () => {
    const a = generateMagicLinkToken();
    const b = generateMagicLinkToken();
    expect(a).not.toBe(b);
  });
});

describe('hashMagicLinkToken', () => {
  // ハッシュは同じ入力に対して常に同じ値、長さは sha256 hex の 64 文字
  it('決定的に SHA-256 hex 64 文字を返す', () => {
    const h1 = hashMagicLinkToken('abc');
    const h2 = hashMagicLinkToken('abc');
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
    expect(h1).toMatch(/^[0-9a-f]+$/);
  });

  // 異なる入力からは異なるハッシュが出ること
  it('入力が異なれば異なるハッシュになる', () => {
    expect(hashMagicLinkToken('abc')).not.toBe(hashMagicLinkToken('abd'));
  });
});

describe('timingSafeHashEqual', () => {
  // 同一の hex 文字列なら true
  it('同一ハッシュで true', () => {
    const h = hashMagicLinkToken('x');
    expect(timingSafeHashEqual(h, h)).toBe(true);
  });

  // 1 文字でも違えば false
  it('異なるハッシュで false', () => {
    const a = hashMagicLinkToken('x');
    const b = hashMagicLinkToken('y');
    expect(timingSafeHashEqual(a, b)).toBe(false);
  });

  // 長さが違うときは投げずに false を返す (timingSafeEqual は通常 throw する)
  it('長さが違うと false (例外を投げない)', () => {
    expect(timingSafeHashEqual('aa', 'aaaa')).toBe(false);
  });
});

describe('buildMagicLinkUrl', () => {
  // 末尾スラッシュの有無に関わらず同じ URL になる
  it('baseUrl 末尾スラッシュを正規化する', () => {
    const u1 = buildMagicLinkUrl('http://localhost:3000', 'tok');
    const u2 = buildMagicLinkUrl('http://localhost:3000/', 'tok');
    expect(u1).toBe(u2);
    expect(u1).toBe('http://localhost:3000/api/auth/magic-link/callback?token=tok');
  });

  // 特殊文字を含むトークンも query エスケープされる
  it('特殊文字を含むトークンを URL-encode する', () => {
    const url = buildMagicLinkUrl('http://x.example', 'a+b/c=d');
    // URLSearchParams が + と / と = をパーセントエンコードする
    expect(url).toContain('token=');
    // 生のまま出ていないこと
    expect(url).not.toContain('token=a+b/c=d');
  });
});

describe('renderMagicLinkEmail', () => {
  // 件名と本文 (text / html) の必須要素が含まれること
  it('text と html に URL と TTL が含まれる', () => {
    const out = renderMagicLinkEmail({
      url: 'http://example.test/click',
      expiresInMinutes: 15,
    });
    expect(out.subject).toContain('ログイン');
    expect(out.text).toContain('http://example.test/click');
    expect(out.text).toContain('15');
    expect(out.html).toContain('http://example.test/click');
  });

  // HTML 本文では危険な文字がエスケープされる
  it('URL に含まれる " や < が HTML 上でエスケープされる', () => {
    const out = renderMagicLinkEmail({
      url: 'http://example.test/?a="<script>',
      expiresInMinutes: 15,
    });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });
});

describe('MAGIC_LINK_TTL_MS', () => {
  // 既定 TTL が 15 分であること (運用ルール検証)
  it('15 分 (900_000 ms)', () => {
    expect(MAGIC_LINK_TTL_MS).toBe(15 * 60 * 1000);
  });
});
