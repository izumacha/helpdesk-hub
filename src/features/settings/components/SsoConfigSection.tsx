'use client';

// Phase 4 Enterprise: SAML SSO 設定セクション (Enterprise プランの管理者向け)。
// docs/smb-dx-pivot-plan.md §6.1 Enterprise「SSO(SAML)」。
// SP 側の情報 (IdP に登録する値) を表示しつつ、IdP の情報を入力して保存する。

// React の Server Action 状態管理フックと送信中フラグ管理フック
import { useActionState, useTransition } from 'react';
// SSO 設定の作成/更新・削除サーバーアクション
import { updateSsoConfig } from '@/features/settings/actions/update-sso-config';
import { deleteSsoConfig } from '@/features/settings/actions/delete-sso-config';

// 現在の SSO 設定 (未設定なら null)
interface SsoConfigView {
  idpEntityId: string; // IdP の EntityID
  idpSsoUrl: string; // IdP の SSO URL
  idpX509Cert: string; // IdP の証明書 (公開情報)
  enabled: boolean; // 有効フラグ
}

// SP 側の URL 群 (IdP 構成のために表示する。秘密情報ではない)
interface SpUrls {
  entityId: string; // SP の EntityID
  acsUrl: string; // ACS (応答 POST 先)
  metadataUrl: string; // SP メタデータ URL
  loginUrl: string; // SSO ログイン開始 URL
}

// 受け取る props
interface Props {
  config: SsoConfigView | null; // 現在の SSO 設定
  sp: SpUrls; // SP 側の URL 群
  planAllowed: boolean; // 現在のプランが SSO を許可するか (false ならプラン降格後で削除のみ可能)
}

// 入力フィールド共通の Tailwind クラス
const fieldClass =
  'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500';
// ラベル共通の Tailwind クラス
const labelClass = 'block text-sm font-medium text-slate-700';
// 補足説明共通の Tailwind クラス
const helpClass = 'mt-1 text-xs text-slate-500';

// SP 情報を 1 行表示する小コンポーネント (ラベル + コピーしやすい値)
function SpField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      {/* 項目名 */}
      <p className="text-xs font-semibold text-slate-500">{label}</p>
      {/* 値 (折り返し可能・等幅でコピーしやすく) */}
      <p className="rounded bg-slate-50 px-2 py-1 font-mono text-xs break-all text-slate-700 ring-1 ring-slate-200">
        {value}
      </p>
    </div>
  );
}

// SSO 設定セクション本体
export function SsoConfigSection({ config, sp, planAllowed }: Props) {
  // 設定保存アクションの状態
  const [saveState, saveAction] = useActionState(updateSsoConfig, {});
  // 設定削除アクションの状態
  const [deleteState, deleteAction] = useActionState(deleteSsoConfig, {});
  // 送信中フラグ (保存・削除で共有)
  const [isPending, startTransition] = useTransition();

  // 保存フォーム送信ハンドラ
  function handleSave(e: React.FormEvent<HTMLFormElement>) {
    // ブラウザ既定の送信を抑止する
    e.preventDefault();
    // フォームデータを取り出してアクションに渡す
    const formData = new FormData(e.currentTarget);
    // トランジション内で実行して isPending を立てる
    startTransition(() => saveAction(formData));
  }

  // 削除ボタンハンドラ
  function handleDelete() {
    // 誤操作防止の確認 (削除すると SSO ログインが無効化される)
    if (!window.confirm('SSO 設定を削除しますか？ SSO ログインが無効になります。')) return;
    // 空の FormData でアクションを呼ぶ
    startTransition(() => deleteAction(new FormData()));
  }

  // プラン降格後 (現在のプランでは SSO を利用できない) は、既存設定の削除だけを案内する
  // 簡易表示にする。再設定フォームを出すと「保存」時にサーバー側のプランゲートで弾かれてしまい
  // 紛らわしいため、削除ボタンのみ表示する
  if (!planAllowed) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          現在のプランでは SSO をご利用いただけません。既存の設定を削除できます
          （再設定するにはプランのアップグレードが必要です）。
        </p>
        {/* 削除結果メッセージ */}
        {deleteState.error && (
          <p role="alert" className="text-sm text-rose-700">
            {deleteState.error}
          </p>
        )}
        {deleteState.success && (
          <p role="status" aria-live="polite" className="text-sm text-teal-700">
            SSO 設定を削除しました。
          </p>
        )}
        {/* 削除ボタン (設定が存在する場合のみ表示) */}
        {config && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={isPending}
            className="rounded-lg px-4 py-2 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
          >
            設定を削除
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── SP 情報 (IdP 側に登録する値) ─────────────────────────── */}
      <div className="space-y-3 rounded-xl bg-slate-50/60 p-4 ring-1 ring-slate-200">
        <p className="text-sm font-semibold text-slate-700">IdP 側に登録する SP 情報</p>
        <p className={helpClass}>
          ご利用の IdP (Okta・Azure AD・Google Workspace など) に以下の値を登録してください。
          メタデータ URL を取り込める IdP では、メタデータ URL の指定だけで設定できます。
        </p>
        {/* SP の各 URL を表示する */}
        <SpField label="SP EntityID" value={sp.entityId} />
        <SpField label="ACS URL (アサーション応答先)" value={sp.acsUrl} />
        <SpField label="メタデータ URL" value={sp.metadataUrl} />
        <SpField label="ログイン開始 URL" value={sp.loginUrl} />
      </div>

      {/* ── IdP 情報の入力フォーム ───────────────────────────────── */}
      <form onSubmit={handleSave} className="space-y-4">
        {/* IdP EntityID */}
        <div className="space-y-1">
          <label htmlFor="idp-entity-id" className={labelClass}>
            IdP EntityID (Issuer)
          </label>
          <p className={helpClass}>
            IdP が発行する識別子。受信したログイン応答の発行元検証に使います。
          </p>
          <input
            id="idp-entity-id"
            name="idpEntityId"
            type="text"
            defaultValue={config?.idpEntityId ?? ''}
            placeholder="https://idp.example.com/entity"
            autoComplete="off"
            required
            className={fieldClass}
          />
        </div>

        {/* IdP SSO URL */}
        <div className="space-y-1">
          <label htmlFor="idp-sso-url" className={labelClass}>
            IdP SSO URL
          </label>
          <p className={helpClass}>ログイン時にユーザーをリダイレクトする IdP のログイン URL。</p>
          <input
            id="idp-sso-url"
            name="idpSsoUrl"
            type="url"
            defaultValue={config?.idpSsoUrl ?? ''}
            placeholder="https://idp.example.com/sso"
            autoComplete="off"
            required
            className={fieldClass}
          />
        </div>

        {/* IdP 証明書 */}
        <div className="space-y-1">
          <label htmlFor="idp-cert" className={labelClass}>
            IdP X.509 証明書
          </label>
          <p className={helpClass}>
            IdP の署名検証用の公開証明書。PEM 形式（-----BEGIN CERTIFICATE-----）または その base64
            本体を貼り付けてください。
          </p>
          <textarea
            id="idp-cert"
            name="idpX509Cert"
            rows={5}
            defaultValue={config?.idpX509Cert ?? ''}
            placeholder="-----BEGIN CERTIFICATE-----&#10;MIID...&#10;-----END CERTIFICATE-----"
            autoComplete="off"
            required
            className={`${fieldClass} font-mono`}
          />
        </div>

        {/* 有効化チェックボックス */}
        <div className="flex items-center gap-2">
          <input
            id="sso-enabled"
            name="enabled"
            type="checkbox"
            defaultChecked={config?.enabled ?? false}
            className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
          />
          <label htmlFor="sso-enabled" className="text-sm text-slate-700">
            SSO ログインを有効にする
          </label>
        </div>

        {/* エラーメッセージ (保存) */}
        {saveState.error && (
          <p role="alert" className="text-sm text-rose-700">
            {saveState.error}
          </p>
        )}
        {/* 成功メッセージ (保存) */}
        {saveState.success && (
          <p role="status" aria-live="polite" className="text-sm text-teal-700">
            SSO 設定を保存しました。
          </p>
        )}
        {/* 削除結果メッセージ */}
        {deleteState.error && (
          <p role="alert" className="text-sm text-rose-700">
            {deleteState.error}
          </p>
        )}
        {deleteState.success && (
          <p role="status" aria-live="polite" className="text-sm text-teal-700">
            SSO 設定を削除しました。
          </p>
        )}

        {/* 操作ボタン群 */}
        <div className="flex flex-wrap items-center gap-3">
          {/* 保存ボタン */}
          <button
            type="submit"
            disabled={isPending}
            className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? '保存中…' : 'SSO 設定を保存'}
          </button>
          {/* 削除ボタン (設定が存在する場合のみ表示) */}
          {config && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={isPending}
              className="rounded-lg px-4 py-2 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
            >
              設定を削除
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
