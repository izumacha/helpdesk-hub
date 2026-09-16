// AI FAQ 自己解決の計測記録 (DeflectionEvent) のリポジトリ契約 (port)。
// docs/smb-dx-pivot-plan.md §4.29 / §6.1 Pro「AI FAQ 自己解決」。
// 全メソッドが tenantId 必須。テナント越境の参照/更新を Adapter 層で遮断する (§5.6)

// ドメイン型 (計測記録と決着状態)
import type { DeflectionEvent, DeflectionOutcome } from '@/domain/types';

// 計測記録を新規作成するときの入力値
export interface CreateDeflectionEventInput {
  tenantId: string; // 所属テナント ID (マルチテナント化のキー)
  userId: string; // 提案を受けた依頼者のユーザー ID
  outcome: DeflectionOutcome; // 初期の決着状態 (提示できたら suggested、候補が無ければ no_match)
  candidateCount: number; // LLM に渡した前段抽出済み候補の件数
  matchedFaqId: string | null; // LLM が該当と判定した最上位 FAQ の ID (無ければ null)
  model: string | null; // 照合に使ったモデル名 (LLM 未呼び出しなら null)
}

// 決着の更新で受け付ける遷移。suggested からのみ resolved / proceeded に進める
export interface DeflectionOutcomeTransition {
  from: 'suggested'; // 期待する現在状態 (決着待ち)
  to: 'resolved' | 'proceeded'; // 新しい決着状態
}

// 計測記録リポジトリの契約 (port)
export interface DeflectionEventRepository {
  // ID + tenantId で 1 件取得 (他テナントの ID なら null)
  findById(id: string, tenantId: string): Promise<DeflectionEvent | null>;
  // 記録を新規作成する (input.tenantId 必須)
  create(input: CreateDeflectionEventInput): Promise<DeflectionEvent>;
  // 決着状態を更新する (tenantId + userId スコープ。他テナント/他人の記録なら 0 件更新で no-op)。
  // transition.from (期待する現在状態) を where 条件に含めた原子的更新 (CAS) にし、
  // 二重送信で resolved と proceeded が後勝ちで上書きし合うのを防ぐ。更新できなければ false。
  // ticketId は「起票に進んだ」(proceeded) ときに紐づけるチケット ID (resolved なら null)
  updateOutcome(
    id: string,
    transition: DeflectionOutcomeTransition,
    scope: { tenantId: string; userId: string },
    ticketId: string | null,
  ): Promise<boolean>;
}
