// メール取り込み (Phase 2) の純粋ヘルパー src/lib/inbound-email.ts のユニットテスト。
// DB を持ち込まず、外部入力の正規化・アドレス抽出・トークン生成の境界挙動を網羅する。

// Vitest の DSL
import { describe, expect, it } from 'vitest';
// テスト対象 (純粋関数群)
import {
  INBOUND_BODY_MAX,
  INBOUND_DEFAULT_SUBJECT,
  INBOUND_SUBJECT_MAX,
  buildInboundAddress,
  extractEmailAddress,
  extractInboundToken,
  generateInboundToken,
  localPartOf,
  parseInboundEmail,
} from '@/lib/inbound-email';

describe('extractEmailAddress', () => {
  // 表示名付きヘッダから純粋アドレスを取り出して小文字化する
  it('"表示名 <addr>" 形式からアドレスを取り出し小文字化する', () => {
    expect(extractEmailAddress('鈴木 <Suzuki@Example.COM>')).toBe('suzuki@example.com');
  });

  // アドレス単体もそのまま受け付ける
  it('アドレス単体を受け付ける', () => {
    expect(extractEmailAddress('  user@example.com  ')).toBe('user@example.com');
  });

  // RFC 5322 のコメント付き "addr (Name)" 形式もアドレスを取り出す
  it('"addr (コメント)" 形式からアドレスを取り出す', () => {
    expect(extractEmailAddress('ichiro@example.com (鈴木 一郎)')).toBe('ichiro@example.com');
  });

  // 妥当でない入力 / 空は null
  it('空・null・不正な値は null', () => {
    expect(extractEmailAddress(null)).toBeNull();
    expect(extractEmailAddress('')).toBeNull();
    expect(extractEmailAddress('not-an-email')).toBeNull();
    expect(extractEmailAddress('a b@example.com')).toBeNull(); // 空白入りは不正
  });
});

describe('localPartOf', () => {
  // アドレスのローカルパートを取り出す
  it('"@" より前を返す', () => {
    expect(localPartOf('abc123@inbox.example.com')).toBe('abc123');
  });

  // 不正アドレスは null
  it('不正なアドレスは null', () => {
    expect(localPartOf('@example.com')).toBeNull();
    expect(localPartOf('plainstring')).toBeNull();
  });
});

describe('extractInboundToken', () => {
  // ドメイン指定なしならローカルパートをそのまま返す
  it('ドメイン未指定ならローカルパートを返す', () => {
    expect(extractInboundToken('abc123@inbox.helpdesk-hub.app')).toBe('abc123');
  });

  // ドメイン一致時のみトークンを返す
  it('期待ドメインに一致するときだけトークンを返す', () => {
    expect(extractInboundToken('abc123@inbox.helpdesk-hub.app', 'inbox.helpdesk-hub.app')).toBe(
      'abc123',
    );
    expect(extractInboundToken('abc123@evil.example.com', 'inbox.helpdesk-hub.app')).toBeNull();
  });
});

describe('buildInboundAddress', () => {
  // トークン@ドメイン を組み立てる
  it('トークンとドメインを連結する', () => {
    expect(buildInboundAddress('abc123', 'inbox.helpdesk-hub.app')).toBe(
      'abc123@inbox.helpdesk-hub.app',
    );
  });
});

describe('generateInboundToken', () => {
  // 英小文字 + 数字のみで一定長のトークンを返す
  it('英小文字+数字 16 文字のトークンを生成する', () => {
    const token = generateInboundToken();
    expect(token).toMatch(/^[a-z0-9]{16}$/);
  });

  // 連続生成で衝突しない (実質一意)
  it('連続生成しても重複しない', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateInboundToken()));
    expect(set.size).toBe(200);
  });
});

describe('parseInboundEmail', () => {
  // 正常系: 全フィールドが揃った受信メールを正規化する
  it('正常系: 宛先トークン・送信者・件名・本文を正規化する', () => {
    const result = parseInboundEmail({
      to: 'abc123@inbox.helpdesk-hub.app',
      from: '鈴木 一郎 <ichiro@example.com>',
      subject: 'プリンターが動きません',
      text: '3階のプリンターが反応しません。',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return; // 型ガード
    expect(result.email.recipientToken).toBe('abc123');
    expect(result.email.senderAddress).toBe('ichiro@example.com');
    expect(result.email.senderName).toBe('鈴木 一郎');
    expect(result.email.subject).toBe('プリンターが動きません');
    expect(result.email.body).toBe('3階のプリンターが反応しません。');
  });

  // 件名が空なら既定タイトルにフォールバックする
  it('件名が空なら既定タイトルになる', () => {
    const result = parseInboundEmail({
      to: 'abc123@inbox.helpdesk-hub.app',
      from: 'ichiro@example.com',
      subject: '   ',
      text: '本文だけ',
    });
    expect(result.ok && result.email.subject).toBe(INBOUND_DEFAULT_SUBJECT);
  });

  // 表示名が取れない場合はアドレスを表示名に流用する
  it('表示名が無いときはアドレスを表示名にする', () => {
    const result = parseInboundEmail({
      to: 'abc123@inbox.helpdesk-hub.app',
      from: 'ichiro@example.com',
      subject: '件名',
      text: '本文',
    });
    expect(result.ok && result.email.senderName).toBe('ichiro@example.com');
  });

  // 宛先が不正ならルーティング不能で失敗する
  it('宛先が不正なら失敗する', () => {
    const result = parseInboundEmail({
      to: 'bad',
      from: 'ichiro@example.com',
      subject: 'x',
      text: 'y',
    });
    expect(result.ok).toBe(false);
  });

  // 送信者が不正なら失敗する
  it('送信者が不正なら失敗する', () => {
    const result = parseInboundEmail({ to: 'abc@inbox.app', from: 'bad', subject: 'x', text: 'y' });
    expect(result.ok).toBe(false);
  });

  // 件名・本文の上限超過は切り詰められる (DoS 防止)
  it('件名・本文は上限まで切り詰められる', () => {
    const result = parseInboundEmail({
      to: 'abc@inbox.app',
      from: 'ichiro@example.com',
      subject: 'あ'.repeat(INBOUND_SUBJECT_MAX + 100),
      text: 'い'.repeat(INBOUND_BODY_MAX + 100),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.email.subject.length).toBe(INBOUND_SUBJECT_MAX);
    expect(result.email.body.length).toBe(INBOUND_BODY_MAX);
  });

  // 期待ドメイン不一致なら失敗する (誤ルーティング防止)
  it('期待ドメイン不一致なら失敗する', () => {
    const result = parseInboundEmail(
      { to: 'abc@evil.example.com', from: 'ichiro@example.com', subject: 'x', text: 'y' },
      { expectedDomain: 'inbox.helpdesk-hub.app' },
    );
    expect(result.ok).toBe(false);
  });
});
