// Prisma の一意制約違反 (P2002) かどうかを、エラーメッセージの内容から判定する共通ヘルパー。
//
// /code-review ultra 指摘対応 (2026-07-13): 同じ判定ロジック (メッセージに 'Unique constraint' /
// 'P2002' / 'already exists' のいずれかを含むか) が create-location.ts / update-location.ts /
// regenerate-inbound-token.ts / update-line-config.ts / accept-invitation.ts /
// create-invitations-bulk.ts の 6 箇所にコピペされていた (CLAUDE.md §6: 2〜3 箇所目で重複したら
// 共通化する)。ここへ一元化し、各所は呼び出しに置き換える。
//
// 'already exists' は Prisma 本番アダプタではなく、memory アダプタ (テスト用) が模す一意制約
// 違反のメッセージ (例: location-repository.memory.ts の `"${name}" already exists in tenant...`)
// を検出するために必要 (line-config-repository.memory.ts のように 'P2002' を含む文言を模す
// memory アダプタもあるため、両方の言い回しを許容する)。

// Prisma の一意制約違反、またはそれに相当する memory アダプタのエラーかどうかを判定する。
// err が Error インスタンスでない場合は判定不能として false を返す。
export function isUniqueConstraintError(err: unknown): boolean {
  // Error 以外 (文字列 throw など) はメッセージが無いので判定不能として扱う
  const message = err instanceof Error ? err.message : '';
  // いずれかのキーワードを含めば一意制約違反とみなす
  return (
    message.includes('Unique constraint') ||
    message.includes('P2002') ||
    message.includes('already exists')
  );
}
