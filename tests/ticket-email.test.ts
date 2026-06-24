// Vitest のテスト DSL
import { describe, expect, it } from 'vitest';
// テスト対象 (純粋ヘルパー)
import {
  buildTicketUrl,
  renderTicketReplyEmail,
  renderTicketReceivedEmail,
} from '@/lib/ticket-email';

describe('buildTicketUrl', () => {
  // baseUrl + チケット ID から詳細ページの URL を組み立てられること
  it('baseUrl とチケット ID を結合して /tickets/<id> を返す', () => {
    expect(buildTicketUrl('http://localhost:3000', 'abc123')).toBe(
      'http://localhost:3000/tickets/abc123',
    );
  });

  // baseUrl 末尾のスラッシュは二重スラッシュにならないよう吸収すること
  it('baseUrl 末尾のスラッシュを取り除く', () => {
    expect(buildTicketUrl('https://app.example.com/', 'xyz')).toBe(
      'https://app.example.com/tickets/xyz',
    );
  });

  // パスに使えない文字を含む ID でも percent-encode されること
  it('チケット ID を URL エンコードする', () => {
    expect(buildTicketUrl('http://x', 'a/b c')).toBe('http://x/tickets/a%2Fb%20c');
  });
});

describe('renderTicketReplyEmail', () => {
  // 件名規約: 接頭辞 + 「問い合わせ「<件名>」に新しい返信があります」
  it('件名に接頭辞とチケット件名を含む', () => {
    const { subject } = renderTicketReplyEmail({
      ticketTitle: 'PC が遅い',
      ticketUrl: 'http://localhost:3000/tickets/1',
      commentBody: '再起動をお試しください',
      agentName: '田中',
    });
    expect(subject).toBe('[HelpDesk Hub] 問い合わせ「PC が遅い」に新しい返信があります');
  });

  // テキスト本文に担当者名・返信本文・URL がそのまま含まれること
  it('テキスト本文に担当者名・返信本文・URL を含む', () => {
    const { text } = renderTicketReplyEmail({
      ticketTitle: '複合機の不調',
      ticketUrl: 'http://localhost:3000/tickets/2',
      commentBody: '担当者が向かいます',
      agentName: '鈴木',
    });
    expect(text).toContain('鈴木');
    expect(text).toContain('担当者が向かいます');
    expect(text).toContain('http://localhost:3000/tickets/2');
  });

  // HTML 本文では外部由来文字列がエスケープされ、生のタグが混入しないこと (XSS 防止)
  it('HTML 本文で件名・本文の危険文字をエスケープする', () => {
    const { html } = renderTicketReplyEmail({
      ticketTitle: '<script>alert(1)</script>',
      ticketUrl: 'http://x/tickets/3',
      commentBody: 'a & b <b>太字</b>',
      agentName: '"運用"',
    });
    // 生の <script> タグがそのまま入っていないこと
    expect(html).not.toContain('<script>');
    // エスケープ済みの実体参照になっていること
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b &lt;b&gt;');
    expect(html).toContain('&quot;運用&quot;');
  });

  // 返信本文の改行は HTML では <br> に変換されること (本文をエスケープした後で変換する)
  it('HTML 本文で改行を <br> に変換する', () => {
    const { html } = renderTicketReplyEmail({
      ticketTitle: 't',
      ticketUrl: 'http://x/tickets/4',
      commentBody: '1 行目\n2 行目',
      agentName: 'a',
    });
    expect(html).toContain('1 行目<br>2 行目');
  });
});

describe('renderTicketReceivedEmail', () => {
  // 件名規約: 接頭辞 + 受付番号 + 件名 (受信箱で「受け付けられた」ことと対象がすぐ分かる)
  it('件名に接頭辞・受付番号・件名を含む', () => {
    const { subject } = renderTicketReceivedEmail({
      ticketTitle: 'プリンターが動かない',
      ticketRef: '#ab12cd34',
      ticketUrl: 'http://localhost:3000/tickets/ab12cd34xxxx',
    });
    expect(subject).toBe(
      '[HelpDesk Hub] お問い合わせを受け付けました（#ab12cd34）「プリンターが動かない」',
    );
  });

  // テキスト本文に受付番号・件名・URL と「返信で追記できる」案内が含まれること
  it('テキスト本文に受付番号・件名・URL・返信案内を含む', () => {
    const { text } = renderTicketReceivedEmail({
      ticketTitle: '複合機の不調',
      ticketRef: '#ffffffff',
      ticketUrl: 'http://localhost:3000/tickets/2',
    });
    expect(text).toContain('#ffffffff');
    expect(text).toContain('複合機の不調');
    expect(text).toContain('http://localhost:3000/tickets/2');
    // このメールに返信するとお問い合わせへ追記される旨の案内
    expect(text).toContain('返信');
  });

  // HTML 本文では外部由来文字列がエスケープされ、生のタグが混入しないこと (XSS 防止)
  it('HTML 本文で件名の危険文字をエスケープする', () => {
    const { html } = renderTicketReceivedEmail({
      ticketTitle: '<script>alert(1)</script>',
      ticketRef: '#deadbeef',
      ticketUrl: 'http://x/tickets/3',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
