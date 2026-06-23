/**
 * Ticket reply email helpers (pure URL building / email rendering).
 *
 * Phase 2「対応すると依頼者にメールで返信が届く」(docs/smb-dx-pivot-plan.md §4 Phase 2)
 * の本文組み立てを 1 か所にまとめた純粋ヘルパー。担当者がコメント (返信) すると、依頼者が
 * アプリにログインしなくても内容を確認できるよう、依頼者宛メールの件名・本文 (Text / HTML)
 * を生成する。送信そのものは呼び出し側 (コメント投稿 Route Handler) が `getEmailSender()`
 * 経由で行い、ここでは「何を送るか」だけを決める (テスト容易性のため副作用を持たない)。
 *
 * 件名規約 (Phase 2 メール通知テンプレート整備): `[HelpDesk Hub] 問い合わせ「<件名>」に新しい返信があります`。
 * 受信者が件名だけで「どの問い合わせか」「何が起きたか」を判別できるようにする。
 */

// HTML 本文に外部由来文字列を差し込む前のエスケープ (共有ヘルパーを再利用)
import { escapeHtml } from '@/lib/html-escape';

// メール件名の接頭辞。受信箱でのフィルタ/識別を容易にするため一元管理する
const SUBJECT_PREFIX = '[HelpDesk Hub]';

// メール件名からヘッダインジェクション文字 (CR / LF) を除去するサニタイザ
// チケットタイトルなどユーザー由来の文字列を件名に埋め込む前に必ず通す
// 例: "foo\r\nBcc: x@y.com" → "foo Bcc: x@y.com"
function sanitizeSubject(s: string): string {
  // \r と \n を半角スペースに置換することで改行による SMTP ヘッダ分割を防ぐ
  return s.replace(/[\r\n]/g, ' ');
}

// 指定した baseUrl とチケット ID から、依頼者が開くチケット詳細ページの URL を組み立てる
// 例: buildTicketUrl('http://localhost:3000', 'abc') -> 'http://localhost:3000/tickets/abc'
export function buildTicketUrl(baseUrl: string, ticketId: string): string {
  // 末尾のスラッシュをトリムして二重スラッシュを防ぐ
  const trimmed = baseUrl.replace(/\/$/, '');
  // ID は cuid なので URL パスにそのまま入れられるが、念のため encode する
  return `${trimmed}/tickets/${encodeURIComponent(ticketId)}`;
}

// 担当者の返信を依頼者へ知らせるメール本文を構築する純粋関数 (副作用なし)
export function renderTicketReplyEmail(input: {
  ticketTitle: string; // 問い合わせの件名 (依頼者がどの件か分かるように)
  ticketUrl: string; // チケット詳細ページの URL (続きはアプリで確認できる導線)
  commentBody: string; // 担当者が投稿した返信本文
  agentName: string; // 返信した担当者の表示名
}): { subject: string; text: string; html: string } {
  // 件名: 接頭辞 + 件名規約。ユーザー入力をサニタイズしてヘッダインジェクションを防ぐ
  const subject = sanitizeSubject(
    `${SUBJECT_PREFIX} 問い合わせ「${input.ticketTitle}」に新しい返信があります`,
  );

  // テキスト本文 (HTML 非対応クライアント向けフォールバック)
  const text = [
    `${input.agentName} さんから、お問い合わせ「${input.ticketTitle}」に返信がありました。`,
    '',
    '----------------------------------------',
    input.commentBody, // 返信本文はテキストなのでエスケープ不要
    '----------------------------------------',
    '',
    '続きの確認や返信は、下のリンクから行えます。',
    `${input.ticketUrl}`,
    '',
    'このメールに心当たりがない場合は破棄してください。',
  ].join('\n');

  // HTML 本文に差し込む外部由来文字列を個別にエスケープする (XSS / 文面崩れ防止)
  const escapedTitle = escapeHtml(input.ticketTitle);
  const escapedAgent = escapeHtml(input.agentName);
  const escapedUrl = escapeHtml(input.ticketUrl);
  // 返信本文は改行を <br> に変換しつつ、本文自体は先にエスケープする (順序が逆だと <br> も実体化される)
  const escapedBody = escapeHtml(input.commentBody).replace(/\n/g, '<br>');

  // HTML 本文 (返信本文を引用ブロックで見せ、続きはボタンでアプリへ誘導する)
  const html = `
    <p>${escapedAgent} さんから、お問い合わせ「${escapedTitle}」に返信がありました。</p>
    <blockquote style="margin:0 0 16px;padding:12px 16px;border-left:4px solid #0f766e;background:#f1f5f9;color:#0f172a;white-space:pre-wrap;">${escapedBody}</blockquote>
    <p><a href="${escapedUrl}" style="display:inline-block;padding:10px 16px;background:#0f766e;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600;">問い合わせを開く</a></p>
    <p style="font-size:13px;color:#475569;">うまく開けない場合はこちらの URL をブラウザに貼り付けてください:<br><span style="word-break:break-all;">${escapedUrl}</span></p>
    <p style="font-size:13px;color:#64748b;">このメールに心当たりがない場合は破棄してください。</p>
  `.trim();

  // 3 点セットを返す
  return { subject, text, html };
}

// 初回メール起票の受領自動返信メール本文を生成する純粋関数 (副作用なし)
// メンバー改善 #1 / Phase 2「依頼者がアプリにログインしなくても完結」(docs/smb-dx-pivot-plan.md §4 Phase 2)。
// Web フォーム起票は送信後すぐ画面に出るが、メール起票は受領確認が無いと「届いたか不明」になるため、
// 起票成功時に「受け付けました」を 1 通だけ返して不安を解消する。
export function renderTicketReceivedEmail(input: {
  ticketTitle: string; // 問い合わせの件名
  ticketRef: string; // 受付番号 (例: "#ab12cd34" / 画面の短縮 ID と同じ表記)
  ticketUrl: string; // チケット詳細ページの URL
}): { subject: string; text: string; html: string } {
  // 件名: 接頭辞 + 受付番号 + 件名。受信箱で「受け付けられた」ことと対象がすぐ分かるようにする。
  // ヘッダインジェクション防止のためサニタイズする
  const subject = sanitizeSubject(
    `${SUBJECT_PREFIX} お問い合わせを受け付けました（${input.ticketRef}）「${input.ticketTitle}」`,
  );

  // テキスト本文 (HTML 非対応クライアント向けフォールバック)
  const text = [
    'お問い合わせを受け付けました。担当者が確認のうえご連絡します。',
    '',
    `受付番号: ${input.ticketRef}`,
    `件名: ${input.ticketTitle}`,
    '',
    '対応状況の確認や追加の連絡は、下のリンクから行えます。',
    `${input.ticketUrl}`,
    '',
    'このメールにそのまま返信すると、お問い合わせへの追記として担当者に届きます。',
    'お心当たりがない場合は破棄してください。',
  ].join('\n');

  // HTML 本文に差し込む外部由来文字列を個別にエスケープする (XSS / 文面崩れ防止)
  const escapedTitle = escapeHtml(input.ticketTitle);
  const escapedRef = escapeHtml(input.ticketRef);
  const escapedUrl = escapeHtml(input.ticketUrl);

  // HTML 本文 (受付番号と件名を示し、続きはボタンでアプリへ誘導する)
  const html = `
    <p>お問い合わせを受け付けました。担当者が確認のうえご連絡します。</p>
    <blockquote style="margin:0 0 16px;padding:12px 16px;border-left:4px solid #0f766e;background:#f1f5f9;color:#0f172a;">
      受付番号: <strong>${escapedRef}</strong><br>
      件名: <strong>${escapedTitle}</strong>
    </blockquote>
    <p><a href="${escapedUrl}" style="display:inline-block;padding:10px 16px;background:#0f766e;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600;">問い合わせを開く</a></p>
    <p style="font-size:13px;color:#475569;">うまく開けない場合はこちらの URL をブラウザに貼り付けてください:<br><span style="word-break:break-all;">${escapedUrl}</span></p>
    <p style="font-size:13px;color:#475569;">このメールにそのまま返信すると、お問い合わせへの追記として担当者に届きます。</p>
    <p style="font-size:13px;color:#64748b;">お心当たりがない場合は破棄してください。</p>
  `.trim();

  // 3 点セットを返す
  return { subject, text, html };
}

// ステータス変更を依頼者に知らせるメール本文を生成する純粋関数 (副作用なし)
// Phase 2 メール通知テンプレート整備 (docs/smb-dx-pivot-plan.md §4 Phase 2)
export function renderTicketStatusChangedEmail(input: {
  ticketTitle: string; // 問い合わせの件名
  ticketUrl: string; // チケット詳細ページの URL
  oldStatusLabel: string; // 変更前ステータスの日本語ラベル (例: 「受付中」)
  newStatusLabel: string; // 変更後ステータスの日本語ラベル (例: 「対応中」)
}): { subject: string; text: string; html: string } {
  // 件名: 接頭辞 + 変更前後のステータスを明示する。ヘッダインジェクション防止のためサニタイズする
  const subject = sanitizeSubject(
    `${SUBJECT_PREFIX} 問い合わせ「${input.ticketTitle}」の状況が「${input.oldStatusLabel}」から「${input.newStatusLabel}」に変わりました`,
  );

  // テキスト本文 (HTML 非対応クライアント向けフォールバック)
  const text = [
    `お問い合わせ「${input.ticketTitle}」の状況が変更されました。`,
    '',
    `変更前: ${input.oldStatusLabel}`,
    `変更後: ${input.newStatusLabel}`,
    '',
    '詳細の確認は、下のリンクから行えます。',
    `${input.ticketUrl}`,
    '',
    'このメールに心当たりがない場合は破棄してください。',
  ].join('\n');

  // HTML 本文に差し込む外部由来文字列を個別にエスケープする (XSS / 文面崩れ防止)
  const escapedTitle = escapeHtml(input.ticketTitle);
  const escapedOld = escapeHtml(input.oldStatusLabel);
  const escapedNew = escapeHtml(input.newStatusLabel);
  const escapedUrl = escapeHtml(input.ticketUrl);

  // HTML 本文 (変更前後を並べて表示し、続きはボタンでアプリへ誘導する)
  const html = `
    <p>お問い合わせ「${escapedTitle}」の状況が変更されました。</p>
    <blockquote style="margin:0 0 16px;padding:12px 16px;border-left:4px solid #0f766e;background:#f1f5f9;color:#0f172a;">
      変更前: <strong>${escapedOld}</strong><br>
      変更後: <strong>${escapedNew}</strong>
    </blockquote>
    <p><a href="${escapedUrl}" style="display:inline-block;padding:10px 16px;background:#0f766e;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600;">問い合わせを開く</a></p>
    <p style="font-size:13px;color:#475569;">うまく開けない場合はこちらの URL をブラウザに貼り付けてください:<br><span style="word-break:break-all;">${escapedUrl}</span></p>
    <p style="font-size:13px;color:#64748b;">このメールに心当たりがない場合は破棄してください。</p>
  `.trim();

  // 3 点セットを返す
  return { subject, text, html };
}

// 担当者割当を担当者に知らせるメール本文を生成する純粋関数 (副作用なし)
// Phase 2 メール通知テンプレート整備 (docs/smb-dx-pivot-plan.md §4 Phase 2)
export function renderAssignedEmail(input: {
  ticketTitle: string; // 問い合わせの件名
  ticketUrl: string; // チケット詳細ページの URL
}): { subject: string; text: string; html: string } {
  // 件名: 接頭辞 + 担当者割当が起きたことを件名で伝える。ヘッダインジェクション防止のためサニタイズする
  const subject = sanitizeSubject(
    `${SUBJECT_PREFIX} 問い合わせ「${input.ticketTitle}」の担当者に割り当てられました`,
  );

  // テキスト本文 (HTML 非対応クライアント向けフォールバック)
  const text = [
    `お問い合わせ「${input.ticketTitle}」の担当者に割り当てられました。`,
    '',
    '詳細の確認や対応は、下のリンクから行えます。',
    `${input.ticketUrl}`,
    '',
    'このメールに心当たりがない場合は破棄してください。',
  ].join('\n');

  // HTML 本文に差し込む外部由来文字列を個別にエスケープする (XSS / 文面崩れ防止)
  const escapedTitle = escapeHtml(input.ticketTitle);
  const escapedUrl = escapeHtml(input.ticketUrl);

  // HTML 本文 (割当を通知し、続きはボタンでアプリへ誘導する)
  // blockquote は「引用」を表す要素なので、返信本文がない担当割当通知には使わない
  const html = `
    <p>お問い合わせ「${escapedTitle}」の担当者に割り当てられました。</p>
    <p>チケットを確認し、対応を開始してください。</p>
    <p><a href="${escapedUrl}" style="display:inline-block;padding:10px 16px;background:#0f766e;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600;">問い合わせを開く</a></p>
    <p style="font-size:13px;color:#475569;">うまく開けない場合はこちらの URL をブラウザに貼り付けてください:<br><span style="word-break:break-all;">${escapedUrl}</span></p>
    <p style="font-size:13px;color:#64748b;">このメールに心当たりがない場合は破棄してください。</p>
  `.trim();

  // 3 点セットを返す
  return { subject, text, html };
}
