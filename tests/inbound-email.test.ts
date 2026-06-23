// メール取り込み (Phase 2) の純粋ヘルパー src/lib/inbound-email.ts のユニットテスト。
// DB を持ち込まず、外部入力の正規化・アドレス抽出・トークン生成の境界挙動を網羅する。

// Vitest の DSL
import { describe, expect, it } from 'vitest';
// テスト対象 (純粋関数群)
import {
  INBOUND_BODY_MAX,
  INBOUND_DEFAULT_SUBJECT,
  INBOUND_MAX_REFERENCE_IDS,
  INBOUND_MESSAGE_ID_MAX,
  INBOUND_SUBJECT_MAX,
  buildInboundAddress,
  extractAuthResults,
  extractEmailAddress,
  extractInboundToken,
  extractMessageIds,
  evaluateInboundAuth,
  generateInboundToken,
  localPartOf,
  normalizeMessageId,
  parseInboundEmail,
  readRawHeader,
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

  // スレッド継続: Message-ID / In-Reply-To / References を正規化して取り込む
  it('Message-ID と参照 ID を正規化して email に載せる', () => {
    const result = parseInboundEmail({
      to: 'abc123@inbox.helpdesk-hub.app',
      from: 'ichiro@example.com',
      subject: 'Re: プリンター',
      text: '直りました',
      messageId: '  <reply-1@inbox.helpdesk-hub.app>  ',
      inReplyTo: '<orig-1@example.com>',
      references: '<root@example.com> <orig-1@example.com>',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 山括弧と前後空白を除いた値になる
    expect(result.email.messageId).toBe('reply-1@inbox.helpdesk-hub.app');
    // In-Reply-To + References を統合し重複排除する (orig-1 は 1 件に)
    expect(result.email.referenceIds).toEqual(['orig-1@example.com', 'root@example.com']);
  });

  // スレッド継続: ヘッダが無いメールは messageId=null / referenceIds=[] になる
  it('スレッドヘッダが無ければ messageId は null・参照は空配列', () => {
    const result = parseInboundEmail({
      to: 'abc123@inbox.helpdesk-hub.app',
      from: 'ichiro@example.com',
      subject: '新規',
      text: '本文',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.email.messageId).toBeNull();
    expect(result.email.referenceIds).toEqual([]);
  });
});

describe('normalizeMessageId', () => {
  // 山括弧と前後空白を外す
  it('"<id@host>" から山括弧を外して返す', () => {
    expect(normalizeMessageId('  <abc@example.com>  ')).toBe('abc@example.com');
  });

  // 山括弧なしでも妥当ならそのまま
  it('山括弧なしの妥当な値はそのまま返す', () => {
    expect(normalizeMessageId('abc@example.com')).toBe('abc@example.com');
  });

  // 空・null・"@" 無し・空白入り・長すぎは null (fail-closed)
  it('不正な値は null を返す', () => {
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeMessageId('')).toBeNull();
    expect(normalizeMessageId('no-at-sign')).toBeNull();
    expect(normalizeMessageId('<a b@example.com>')).toBeNull();
    expect(normalizeMessageId('x@' + 'a'.repeat(INBOUND_MESSAGE_ID_MAX))).toBeNull();
    // 外側 1 組を外しても山括弧が残る (複数 ID 連結) のは不正
    expect(normalizeMessageId('<a@b><c@d>')).toBeNull();
  });
});

describe('extractMessageIds', () => {
  // 空白区切りの "<id>" 列を分解して正規化する
  it('References の "<id> <id>" 列を分解する', () => {
    expect(extractMessageIds('<a@x.com>\n <b@y.com>')).toEqual(['a@x.com', 'b@y.com']);
  });

  // 山括弧が無い単一トークンも受ける
  it('山括弧なしの単一トークンも受ける', () => {
    expect(extractMessageIds('a@x.com')).toEqual(['a@x.com']);
  });

  // 取り込み件数は上限でクランプする (DoS 防止)
  it('参照 ID は上限件数までに切り詰める', () => {
    // 上限 + 10 件の "<id>" を並べる
    const many = Array.from(
      { length: INBOUND_MAX_REFERENCE_IDS + 10 },
      (_, i) => `<id${i}@x.com>`,
    ).join(' ');
    expect(extractMessageIds(many).length).toBe(INBOUND_MAX_REFERENCE_IDS);
  });

  // 空・null は空配列
  it('空・null は空配列', () => {
    expect(extractMessageIds(null)).toEqual([]);
    expect(extractMessageIds('')).toEqual([]);
  });
});

describe('readRawHeader', () => {
  // 生ヘッダ文字列から大文字小文字を無視して値を取り出す
  it('ヘッダ名を大文字小文字無視で取り出す', () => {
    const raw = 'From: a@x.com\r\nMessage-ID: <m1@x.com>\r\nSubject: hi';
    expect(readRawHeader(raw, 'message-id')).toBe('<m1@x.com>');
  });

  // 折り返された継続行 (先頭が空白) を 1 行に連結する
  it('折り返し継続行を連結する', () => {
    const raw = 'References: <a@x.com>\r\n <b@x.com>\r\nSubject: hi';
    expect(readRawHeader(raw, 'References')).toBe('<a@x.com> <b@x.com>');
  });

  // 見つからない / 空入力は null
  it('見つからなければ null', () => {
    expect(readRawHeader('Subject: hi', 'Message-ID')).toBeNull();
    expect(readRawHeader(null, 'Message-ID')).toBeNull();
  });
});

describe('extractAuthResults', () => {
  // SendGrid 個別フィールド (SPF / dkim) から結果を取り出す
  it('SendGrid の個別フィールドから SPF / DKIM を正規化する', () => {
    const r = extractAuthResults({ spf: 'pass', dkim: '{@example.com : pass}' });
    expect(r.spf).toBe('pass'); // SPF=pass
    expect(r.dkim).toBe('pass'); // dkim フィールド内の pass を拾う
    expect(r.dmarc).toBe('unknown'); // DMARC は個別フィールドが無いので unknown
  });

  // 個別フィールドの fail / softfail を区別して正規化する
  it('fail と softfail を区別する', () => {
    expect(extractAuthResults({ spf: 'fail' }).spf).toBe('fail'); // 明示 fail
    expect(extractAuthResults({ spf: 'softfail' }).spf).toBe('softfail'); // softfail は fail と別
  });

  // 汎用 Authentication-Results ヘッダから spf= / dkim= / dmarc= を抽出する
  it('Authentication-Results ヘッダから 3 方式を抽出する', () => {
    const header = 'mx.example.com; spf=pass smtp.mailfrom=a@x.com; dkim=fail header.d=x.com; dmarc=fail';
    const r = extractAuthResults({ authenticationResults: header });
    expect(r.spf).toBe('pass'); // spf=pass
    expect(r.dkim).toBe('fail'); // dkim=fail
    expect(r.dmarc).toBe('fail'); // dmarc=fail
  });

  // 個別フィールドが汎用ヘッダより優先される
  it('個別フィールドが Authentication-Results より優先される', () => {
    const r = extractAuthResults({ spf: 'fail', authenticationResults: 'spf=pass; dmarc=pass' });
    expect(r.spf).toBe('fail'); // 個別フィールド (fail) を優先
    expect(r.dmarc).toBe('pass'); // 個別フィールドが無い DMARC はヘッダ由来
  });

  // プロバイダが結果を提供しない場合は unknown
  it('情報が無ければすべて unknown', () => {
    const r = extractAuthResults({});
    expect(r).toEqual({ spf: 'unknown', dkim: 'unknown', dmarc: 'unknown' });
  });
});

describe('evaluateInboundAuth', () => {
  // off / 未設定では常に accept (後方互換)
  it('off / 未設定では常に accept', () => {
    const fail = { spf: 'fail', dkim: 'fail', dmarc: 'fail' } as const;
    expect(evaluateInboundAuth(fail, '')).toBe('accept'); // 未設定
    expect(evaluateInboundAuth(fail, 'off')).toBe('accept'); // off
  });

  // enforce で明示 fail があれば quarantine
  it('enforce では明示 fail を quarantine', () => {
    expect(evaluateInboundAuth({ spf: 'fail', dkim: 'pass', dmarc: 'pass' }, 'enforce')).toBe('quarantine');
    expect(evaluateInboundAuth({ spf: 'pass', dkim: 'fail', dmarc: 'pass' }, 'enforce')).toBe('quarantine');
    expect(evaluateInboundAuth({ spf: 'pass', dkim: 'pass', dmarc: 'fail' }, 'enforce')).toBe('quarantine');
  });

  // enforce でも pass / softfail / none / unknown は accept (誤隔離・可用性低下を避ける)
  it('enforce でも pass / softfail / unknown は accept', () => {
    expect(evaluateInboundAuth({ spf: 'pass', dkim: 'pass', dmarc: 'pass' }, 'enforce')).toBe('accept');
    expect(evaluateInboundAuth({ spf: 'softfail', dkim: 'none', dmarc: 'unknown' }, 'enforce')).toBe('accept');
    expect(evaluateInboundAuth({ spf: 'unknown', dkim: 'unknown', dmarc: 'unknown' }, 'enforce')).toBe('accept');
  });

  // ポリシー文字列の大文字・前後空白を許容する
  it('ENFORCE / 前後空白でも有効', () => {
    expect(evaluateInboundAuth({ spf: 'fail', dkim: 'pass', dmarc: 'pass' }, '  Enforce ')).toBe('quarantine');
  });
});
