// JSON レスポンスを返すヘルパー
import { NextResponse } from 'next/server';
// crypto ベースの UUID 生成 (保存先キー組み立て用)
import { randomUUID } from 'node:crypto';
// セッション取得
import { auth } from '@/lib/auth';
// リポジトリ束 (tickets/categories/attachments など) と Storage Port
import { repos, storage, uow } from '@/data';
// 優先度から解決期限を計算する SLA ヘルパー
import { calculateResolutionDueAt } from '@/lib/sla';
// 新規チケット入力の Zod スキーマ
import { createTicketSchema } from '@/lib/validations/ticket';
// 添付ファイル検証ヘルパー
import { validateUploadedFiles } from '@/lib/validations/attachment';
// MIME → 拡張子の対応表 (storageKey の組み立てで使用)
import { MIME_TO_EXTENSION } from '@/domain/attachment';
// テナントの動作モード (lite | pro) を取得するヘルパー
import { getCurrentTenantMode } from '@/lib/tenant';
// 'YYYY-MM-DD' を JST 終端 Date に変換するヘルパー (サーバ TZ 非依存)
import { endOfDayJST } from '@/lib/format-date';

// 422 (バリデーションエラー) を共通フォーマットで返すヘルパー
function validationError(message: string, path: (string | number)[]) {
  // フォーム側が読みやすいよう Zod 互換の issues 形状で返す
  return NextResponse.json(
    {
      error: '入力値が正しくありません',
      issues: [{ code: 'custom', path, message }],
    },
    { status: 422 },
  );
}

// POST /api/tickets : 新規チケットを作成する HTTP エンドポイント
// - Content-Type が application/json なら従来どおり JSON で受ける (添付なしフォーム / API クライアント)
// - Content-Type が multipart/form-data なら FormData として受け取り、files フィールドを添付として処理する
export async function POST(req: Request) {
  // セッション取得
  const session = await auth();
  // 未ログインなら 401 を返す
  if (!session?.user?.id) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
  }

  // セッションから tenantId を取り出して以降の where 句注入に使う
  const tenantId = session.user.tenantId;
  // 起票者 ID (添付メタの uploaderId にも使う)
  const userId = session.user.id;

  // 入力値とアップロードされた File 配列を保持する変数
  let rawInput: Record<string, unknown>;
  let uploadedFiles: File[] = [];

  // Content-Type で JSON / multipart を判別する (大文字小文字を許容)
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    // multipart/form-data を FormData として読み出す
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      // 不正な FormData は 400 で弾く
      return NextResponse.json(
        { error: 'リクエストの形式が正しくありません' },
        { status: 400 },
      );
    }
    // テキスト系フィールドを 1 つのオブジェクトに集約 (Zod へ渡すため)
    rawInput = {
      title: form.get('title') ?? undefined,
      body: form.get('body') ?? undefined,
      categoryId: form.get('categoryId') ?? undefined,
      priority: form.get('priority') ?? undefined,
      dueDate: form.get('dueDate') ?? undefined,
    };
    // files フィールドを全て拾い、File 型だけ抽出する (空入力で文字列 "" が混ざるのを除外)
    uploadedFiles = form
      .getAll('files')
      .filter((entry): entry is File => entry instanceof File);
  } else {
    // 従来どおり JSON ボディとして読み出す
    try {
      rawInput = (await req.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { error: 'リクエストの形式が正しくありません' },
        { status: 400 },
      );
    }
  }

  // Zod で入力値を検証
  const parsed = createTicketSchema.safeParse(rawInput);
  // 検証失敗時は 422 + issues でフォーム側にエラーを返す
  if (!parsed.success) {
    return NextResponse.json(
      { error: '入力値が正しくありません', issues: parsed.error.issues },
      { status: 422 },
    );
  }

  // 添付ファイル群を検証 (件数 / MIME / サイズ)
  const attachmentValidation = validateUploadedFiles(uploadedFiles);
  // 1 件でも違反があれば 422 で返す
  if (!attachmentValidation.ok) {
    return validationError(attachmentValidation.message, ['files']);
  }

  // 検証済みの値を分解 (body は変数名衝突を避けてリネーム)
  const { title, body: ticketBody, priority, categoryId, dueDate } = parsed.data;

  // カテゴリ指定がある場合は存在確認 (現在のテナント内のカテゴリのみ許可)
  // ── mode に関わらずクロステナント検査は必ず走らせる。
  // Lite モードでも「UI から送られないので無視」と黙って drop してしまうと、
  // 外部から他テナントの categoryId が送られたときにクロステナント漏洩防止テスト
  // (e2e/multitenant.spec.ts) が破綻する。Lite UI 自体は categoryId フィールドを
  // 持たないので、正規ルートではそもそも categoryId が undefined で届く
  if (categoryId) {
    // テナントスコープでカテゴリを取得 (他テナントの ID は null になる)
    const category = await repos.categories.findById(categoryId, tenantId);
    // 存在しない、または他テナントなら 422 (Zod 風の issues を返す)
    if (!category) {
      return validationError('指定されたカテゴリが存在しません', ['categoryId']);
    }
  }

  // テナントの動作モードを取得し、Lite モード時の入力強制ルールを適用する
  // ── ここから先は「自テナント内で正規の値しか残っていない」前提でモード適用する
  const mode = await getCurrentTenantMode(tenantId);
  // Lite モードでは優先度を UI から選ばせず Medium 固定とする (Pivot plan §3.1)
  const effectivePriority = mode === 'lite' ? 'Medium' : priority;
  // Lite モードではカテゴリ機能を提供しないため保存時に null へ落とす
  const effectiveCategoryId = mode === 'lite' ? null : (categoryId ?? null);

  // 作成時刻 (SLA 期限の計算基準)
  const now = new Date();
  // 解決期限の決定: dueDate 指定があれば JST 終端、なければ priority ベースで自動計算
  const resolutionDueAt = dueDate
    ? (endOfDayJST(dueDate) ?? calculateResolutionDueAt(effectivePriority, now))
    : calculateResolutionDueAt(effectivePriority, now);

  // 添付なしの単純パス: 従来どおりトランザクション無しで作成して返す
  if (attachmentValidation.files.length === 0) {
    const ticket = await repos.tickets.create({
      title,
      body: ticketBody,
      priority: effectivePriority,
      categoryId: effectiveCategoryId,
      creatorId: userId,
      tenantId,
      resolutionDueAt,
    });
    return NextResponse.json(ticket, { status: 201 });
  }

  // 添付ありパス: チケット作成 + 添付メタ INSERT を 1 トランザクションで実行する
  // ストレージへの書き込みは DB トランザクション外で観測できない副作用なので、
  // 失敗時に手動で書き込み済みファイルを削除してロールバックを揃える
  const writtenKeys: string[] = []; // ロールバック用に書き込み済みキーを蓄える
  try {
    // uow.run のコールバック内で「ストレージ書き込み + DB INSERT」をペアで実行する
    // どちらが失敗しても uow.run 自体が throw して DB は自動ロールバックされる
    const ticket = await uow.run(async (r) => {
      // チケット本体を tx 内で作成
      const t = await r.tickets.create({
        title,
        body: ticketBody,
        priority: effectivePriority,
        categoryId: effectiveCategoryId,
        creatorId: userId,
        tenantId,
        resolutionDueAt,
      });
      // 添付ファイルを 1 件ずつ「ストレージ書き込み → メタ INSERT」の順に処理する
      for (const v of attachmentValidation.files) {
        // 保存先キーを組み立てる (例: tenantId/ticketId/<uuid>.jpg)
        const ext = MIME_TO_EXTENSION[v.mimeType];
        const key = `${tenantId}/${t.id}/${randomUUID()}.${ext}`;
        // File 本体のバイト列を ArrayBuffer 経由で Uint8Array に変換する
        const buf = new Uint8Array(await v.file.arrayBuffer());
        // ストレージへ書き込む (失敗時は catch でクリーンアップ)
        await storage.put(key, buf, { contentType: v.mimeType, size: v.size });
        // ロールバック対象として書き込み済みキーを記録する (DB INSERT 失敗時に削除する)
        writtenKeys.push(key);
        // メタ情報を DB に保存する (storage="local" 固定)
        await r.attachments.create({
          ticketId: t.id,
          commentId: null,
          uploaderId: userId,
          tenantId,
          mimeType: v.mimeType,
          size: v.size,
          originalName: v.originalName,
          storageKey: key,
          storage: 'local',
        });
      }
      // チケットを uow の戻り値として返す (呼び出し元で 201 ボディに使う)
      return t;
    });
    // 成功: 作成された行を 201 で返す
    return NextResponse.json(ticket, { status: 201 });
  } catch (err) {
    // DB は自動ロールバック済。ストレージに書き込んだファイルを best-effort で削除する
    await Promise.all(
      writtenKeys.map((key) =>
        storage.delete(key).catch((cleanupErr) => {
          // 削除失敗はログだけ残して握りつぶす (リトライ用 GC は将来の課題)
          console.warn('[POST /api/tickets] failed to clean up storage', { key, cleanupErr });
        }),
      ),
    );
    // 元のエラーをサーバログに出して 500 を返す
    console.error('[POST /api/tickets] attachment save failed', err);
    return NextResponse.json(
      { error: '添付ファイルの保存に失敗しました' },
      { status: 500 },
    );
  }
}
