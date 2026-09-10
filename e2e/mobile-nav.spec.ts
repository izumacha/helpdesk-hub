// Playwright のテスト DSL と Page 型
import { test, expect, Page } from '@playwright/test';
// E2E 共通のログインヘルパー (§6 DRY: スペックごとに書き写さない)
import { login } from './login';

// モバイル幅 (md 未満) のナビゲーションドロワーの挙動を検証する。
//
// このスペックが存在する理由 (消さないこと): ドロワーの a11y は 2026-09 のレビューで
// 3 巡続けて回帰を出した箇所で、いずれも **lint / typecheck / unit / contract のすべてが
// 緑のまま**通っていた。既定の Playwright プロジェクトは Desktop Chrome (1280px = md 以上) で、
// その幅では `md:visible` / `md:relative` がドロワーの仕組みごと覆い隠すため、
// mobile 幅で見るスペックが 1 本も無いと機構全体が無検証になる。
test.describe('モバイルのナビゲーションドロワー', () => {
  // このスペックだけ iPhone 相当の幅にする (プロジェクト設定は Desktop Chrome のまま)
  test.use({ viewport: { width: 375, height: 812 } });

  // このスペックだけ制限時間を延ばす (プロジェクト全体の既定 30 秒は変えない)。
  // beforeEach のログイン + 本体のドロワー操作はどちらも「ハイドレーション前のクリックを
  // 再試行する」形になっており、再試行が 1 度でも走ると既定の 30 秒では
  // **2 回目が始まる前に打ち切られて再試行そのものが機能しない**。
  // 枠が足りているかは「hooks + 本体で使いうる最大の再試行枠」を足して決める
  test.describe.configure({ timeout: 90_000 });

  // 各テスト共通の前準備 (ログイン → チケット一覧を開く)
  test.beforeEach(async ({ page }) => {
    // エージェントでログインする
    await login(page);
    // チケット一覧を開く (ドロワーは閉じた状態が既定)
    await page.goto('/tickets');
  });

  // ドロワー内の「ダッシュボード」リンクをロールで指すロケータ
  const navLinkByRole = (page: Page) =>
    page.locator('#mobile-sidebar').getByRole('link', { name: 'ダッシュボード' });

  // ドロワーを開くヘルパー。**クリック自体を再試行する**。
  // MobileNavToggle は SSR されるので、ハイドレーション前でもボタンは存在し
  // Playwright の操作可能判定を通ってしまう。その隙にクリックすると onClick が
  // まだ結び付いておらず「押せたのに何も起きない」状態になり、Playwright は
  // 成功したクリックを再試行しないので後続の待機がタイムアウトする
  // (CI の retries: 2 が flake として覆い隠すため、検出網としてはむしろ有害)。
  //
  // 当初は aria-expanded の値を待って「ハイドレーション済み」の合図にしていたが、
  // **この属性はサーバ側の初期 HTML にも同じ値で出る**ためハイドレーションの前後を
  // 区別できず、ガードとして機能していなかった。
  // 「開いていなければ押す → 開いたか確かめる」を成立するまで繰り返す形にすれば、
  // 合図の有無に依存しない。
  //
  // ボタンは **ラベルではなく aria-controls で指す**: ラベルは開閉で
  // 「メニューを開く」⇄「メニューを閉じる」と入れ替わるため、名前で指すと
  // 「1 回目のクリックで開いたが表示の検査に失敗した」場合に再試行が
  // 存在しない要素を待ち続け、本来の失敗理由が制限時間切れに化ける
  async function openDrawer(page: Page) {
    // ハンバーガーを開閉状態に依存しないセレクタで指す
    const toggle = page.locator('button[aria-controls="mobile-sidebar"]');
    // 「閉じていれば押す」と「開いたか」の確認を 1 組にして、成立するまで再試行する
    await expect(async () => {
      // 既に開いている状態で押すと閉じてしまうので、閉じているときだけ押す
      if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
      // ドロワー内のリンクがロールで引けるようになるまで待つ (短めの制限時間で判定する)
      await expect(navLinkByRole(page)).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
  }

  // 閉じているドロワーは「画面外へずらしただけ」ではなく、中の要素ごと
  // タブ順・読み上げ順から外れていること (visibility:hidden)。
  // translate だけで隠していた頃は、スキップリンクの次の Tab で「画面のどこにも見えない
  // ナビリンク」に到達し、Enter でそのまま遷移できてしまった
  test('閉じているあいだナビリンクはフォーカスできない', async ({ page }) => {
    // ドロワー内の「ダッシュボード」リンクを DOM 上の属性で指す
    // (ロールでは引けないことを下で確かめるため、ここでは CSS セレクタを使う)
    const navLinkInDom = page.locator('#mobile-sidebar a[href="/dashboard"]');
    // 要素自体は DOM に残っている (条件描画ではなく CSS で隠しているため)
    await expect(navLinkInDom).toBeAttached();
    // ただし可視ではない = キーボードのフォーカス対象にならない
    await expect(navLinkInDom).not.toBeVisible();
    // **ロールでは 1 件も引けない**ことまで確かめる。visibility:hidden の要素は
    // アクセシビリティツリーからも外れるため、スクリーンリーダーの仮想カーソルも到達しない。
    // translate で画面外へずらしていただけの頃は、ここが 1 件ヒットしていた
    await expect(navLinkByRole(page)).toHaveCount(0);
    // ドロワー内の閉じるボタンも同様にロールから消えている (開くまでは押しようがない)
    await expect(
      page.locator('#mobile-sidebar').getByRole('button', { name: 'ナビゲーションを閉じる' }),
    ).toHaveCount(0);
  });

  // スライドのアニメーションが実際に効いていること。
  // 7 巡目レビューで、遷移対象に `transform` と書いてしまい (Tailwind v4 の translate-x-* は
  // 独立した `translate:` プロパティへコンパイルされる) スライドが丸ごと死んでいたのに
  // lint / typecheck / unit / contract / E2E すべてが緑のまま通った。人が生成 CSS を
  // 読んで初めて気付いた欠陥なので、計算後のスタイルで機械的に固定する
  test('遷移対象に translate が含まれ、開閉で translate が実際に変わる', async ({ page }) => {
    // ドロワー本体を指す
    const drawer = page.locator('#mobile-sidebar');
    // 閉じているときの計算後スタイルを読む
    const closed = await drawer.evaluate((el) => {
      // 計算後のスタイル一式を取得する
      const s = getComputedStyle(el);
      // 遷移対象のプロパティ一覧と、現在の translate 値を返す
      return { transitionProperty: s.transitionProperty, translate: s.translate };
    });
    // 遷移対象に translate が含まれること (transform と書き間違えるとここで落ちる)
    expect(closed.transitionProperty).toContain('translate');
    // 遷移対象に visibility を含めないこと
    // (含めると閉じてから遷移が終わるまでフォーカス可能なままになる。§4.28.4)
    expect(closed.transitionProperty).not.toContain('visibility');
    // ドロワーを開く
    await openDrawer(page);
    // 開いたあとの translate 値を読む
    const opened = await drawer.evaluate((el) => getComputedStyle(el).translate);
    // 開閉で translate が実際に変わっていること (変わらなければ位置が動いていない)
    expect(opened).not.toBe(closed.translate);
  });

  // 開いた直後にフォーカスがドロワーの中へ移ること (背面に取り残さない §7)。
  // これが無いと、キーボード利用者はメニューを開いても Tab を何度も押して
  // 背面のページを通り抜けないとメニューへ到達できない
  test('開くとフォーカスがドロワー内へ移る', async ({ page }) => {
    // ドロワーを開く
    await openDrawer(page);
    // ナビリンクが可視になる
    await expect(navLinkByRole(page)).toBeVisible();
    // フォーカスされている要素がドロワーの内側にあることを確かめる
    await expect(page.locator('#mobile-sidebar :focus')).toHaveCount(1);
  });

  // Tab がドロワー内で循環すること (フォーカストラップ §7)。
  // 末尾の要素から Tab を押しても背面のコンテンツへ抜けない
  test('Tab はドロワー内で循環し背面へ抜けない', async ({ page }) => {
    // ドロワーを開く
    await openDrawer(page);
    // ナビリンクが可視になるまで待つ
    await expect(navLinkByRole(page)).toBeVisible();
    // ドロワー内のフォーカス可能要素の数だけ Tab を押しても、
    // フォーカスは常にドロワーの内側に留まる (一周して戻ってくる)
    const focusableCount = await page
      .locator('#mobile-sidebar a[href], #mobile-sidebar button')
      .count();
    for (let i = 0; i < focusableCount + 1; i += 1) {
      // 1 回 Tab を押す
      await page.keyboard.press('Tab');
      // 押すたびにフォーカスがドロワー内にあることを確かめる
      await expect(page.locator('#mobile-sidebar :focus')).toHaveCount(1);
    }
  });

  // ハンバーガーで開くとナビリンクが可視になり、ドロワー内の閉じるボタンで閉じられること。
  // 閉じるボタンは aria-modal="true" が Header のハンバーガーを支援技術から隠すための
  // 代替の脱出口なので、押して実際に閉じるところまで確かめる
  test('ドロワー内の閉じるボタンで閉じられる', async ({ page }) => {
    // ドロワーを開く
    await openDrawer(page);
    // ナビリンクが可視になる
    await expect(navLinkByRole(page)).toBeVisible();
    // ドロワー内の閉じるボタン (Header のハンバーガーとは別名にしてある) を押す
    await page
      .locator('#mobile-sidebar')
      .getByRole('button', { name: 'ナビゲーションを閉じる' })
      .click();
    // 閉じるとナビリンクは再び不可視になる
    await expect(navLinkByRole(page)).toHaveCount(0);
  });

  // Esc キーでも閉じられ、フォーカスが開く前の要素 (ハンバーガー) へ戻ること
  // (§7「モーダルはフォーカストラップ + Esc で閉じ」+ フォーカス復元)
  test('Esc キーで閉じ、フォーカスがハンバーガーへ戻る', async ({ page }) => {
    // ドロワーを開く
    await openDrawer(page);
    // ナビリンクが可視になる
    await expect(navLinkByRole(page)).toBeVisible();
    // Esc を押す
    await page.keyboard.press('Escape');
    // 閉じてナビリンクがロールから消える
    await expect(navLinkByRole(page)).toHaveCount(0);
    // フォーカスは開く前の要素 = ハンバーガー (閉じた状態のラベル) へ戻っている
    await expect(page.getByRole('button', { name: 'メニューを開く' })).toBeFocused();
  });
});
