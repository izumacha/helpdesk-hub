/**
 * Composition root for the binary storage port.
 *
 * Kept in a separate module from `@/data/index.ts` so that the Local FS adapter
 * (which imports `node:fs/promises` / `node:path`) is never pulled into the
 * request-entry (`src/proxy.ts`) bundle through `src/lib/auth.ts → @/data`.
 *
 * The original reason was a hard constraint: the entry point ran on the Edge
 * runtime, which cannot resolve `node:*` builtins at all. Since issue #298 the
 * entry point is `src/proxy.ts` and always runs on Node.js, so that constraint
 * is gone. The split is kept for a weaker but still valid reason — the entry
 * runs on *every* request, so there is no reason to load filesystem code into
 * it. Do not treat this file as evidence that an Edge constraint still exists.
 *
 * Server Actions and API Route Handlers (Node runtime) should import the
 * `storage` singleton from this module directly.
 */

// ローカル FS ストレージの生成関数 (添付ファイル本体の保存先)
import { createLocalStorage } from './adapters/local/storage.local';
// Storage Port の契約型 (公開 API)
import type { StoragePort } from './ports/storage';

// 型を再公開する (型のみ参照する側からも import しやすいように)
export type { StoragePort } from './ports/storage';

/**
 * Default storage adapter: local filesystem volume.
 *
 * Single-instance only. Multi-instance deployments must replace this with an
 * S3-compatible adapter (see Phase 2 in docs/smb-dx-pivot-plan.md).
 */
// 添付ファイル本体の既定ストレージ (ローカル FS 実装)
// UPLOAD_DIR 環境変数が指定されていればその値、未指定なら './var/uploads' を使う
export const storage: StoragePort = createLocalStorage(process.env.UPLOAD_DIR ?? './var/uploads');
