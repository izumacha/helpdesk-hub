// (app) レイアウトの <main> に振る DOM id の単一の参照元。
// SkipLink (遷移先の href)・(app)/layout.tsx (<main> 本体の id)・RouteFocusManager
// (document.getElementById での取得先) の 3 箇所で同じ文字列を直書きすると、
// 将来どれか 1 箇所だけリネームし忘れた場合にコンパイルエラーも lint エラーも出ないまま
// スキップリンク/フォーカス移動が静かに壊れる (§6 マジック文字列を避ける・単一の参照元に置く)
export const MAIN_CONTENT_ID = 'main-content';
