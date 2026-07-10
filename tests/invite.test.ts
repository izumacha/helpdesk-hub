// extractEmailCandidates (src/lib/invite.ts) の単体テスト。
// §7.1 フォローアップ (2026-07-10): 一括招待の CSV/複数行貼り付け解析ロジックを検証する。

import { describe, expect, it } from 'vitest';
import { extractEmailCandidates } from '@/lib/invite';

describe('extractEmailCandidates', () => {
  // 1 行 1 メールアドレスの単純な貼り付けを候補として抽出できる
  it('1行1メールのテキストから候補を抽出する', () => {
    const raw = 'a@example.com\nb@example.com\nc@example.com';
    expect(extractEmailCandidates(raw)).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com',
    ]);
  });

  // CSV の 1 列目 (メールアドレス列) だけを取り出す (2 列目以降は無視する)
  it('CSV の1列目をメールアドレスとして取り出す', () => {
    const raw = 'a@example.com,agent\nb@example.com,requester';
    expect(extractEmailCandidates(raw)).toEqual(['a@example.com', 'b@example.com']);
  });

  // 空行は無視する (Excel からの CSV エクスポートは末尾に空行が付くことが多い)
  it('空行を無視する', () => {
    const raw = 'a@example.com\n\n\nb@example.com\n';
    expect(extractEmailCandidates(raw)).toEqual(['a@example.com', 'b@example.com']);
  });

  // ヘッダ行らしき単語だけの行 (email / メール / メールアドレス) は候補から除外する
  it('ヘッダ行を除外する', () => {
    expect(extractEmailCandidates('email\na@example.com')).toEqual(['a@example.com']);
    expect(extractEmailCandidates('メールアドレス\na@example.com')).toEqual(['a@example.com']);
    expect(extractEmailCandidates('Email\na@example.com')).toEqual(['a@example.com']);
  });

  // /code-review ultra 指摘対応: ヘッダ除外は入力の 1 行目だけに適用する。
  // リストの途中に偶然「メール」とだけ書かれた行があっても、静かに無視せず候補として残す
  // (そうしないと、その行の意図した中身がコピペミスで欠けていることに管理者が気づけない)
  it('1行目以外の「メール」等はヘッダとして除外しない', () => {
    expect(extractEmailCandidates('a@example.com\nメール\nb@example.com')).toEqual([
      'a@example.com',
      'メール',
      'b@example.com',
    ]);
  });

  // 大文字小文字を無視した重複は除去し、最初に現れた表記を残す
  it('大文字小文字を無視して重複を除去する', () => {
    const raw = 'a@example.com\nA@Example.com\na@example.com';
    expect(extractEmailCandidates(raw)).toEqual(['a@example.com']);
  });

  // 前後の空白はトリムされる
  it('前後の空白をトリムする', () => {
    expect(extractEmailCandidates('  a@example.com  \n')).toEqual(['a@example.com']);
  });

  // 空文字列の入力では空配列を返す (呼び出し側の Zod スキーマが「1件以上」を要求する)
  it('空文字列の入力では空配列を返す', () => {
    expect(extractEmailCandidates('')).toEqual([]);
    expect(extractEmailCandidates('   \n  \n')).toEqual([]);
  });

  // CRLF 改行 (Windows の Excel エクスポート等) でも正しく行分割できる
  it('CRLF 改行でも行分割できる', () => {
    expect(extractEmailCandidates('a@example.com\r\nb@example.com\r\n')).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
  });
});
