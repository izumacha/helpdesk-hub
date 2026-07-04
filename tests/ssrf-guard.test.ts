// SSRF ガード (src/lib/ssrf-guard.ts) の単体テスト。
// isPrivateHost / isUnsafeUrl (ホスト名文字列の検証) に加え、
// ssrfSafeLookup (DNS リバインディング対策: 実際に解決された IP を検証する) を確認する。

// Vitest の DSL とフック
import { afterEach, describe, expect, it, vi } from 'vitest';

// node:dns の lookup をモックし、実際の DNS には問い合わせない
const dnsLookupMock = vi.fn();
vi.mock('node:dns', () => ({
  default: {
    lookup: (...args: unknown[]) => dnsLookupMock(...args),
  },
}));

// モック設定後に読み込む (vi.mock はホイストされるため import 順は問題ない)
import { isPrivateHost, isUnsafeUrl, ssrfSafeLookup } from '@/lib/ssrf-guard';

describe('isPrivateHost', () => {
  // ループバック・リンクローカル・プライベートアドレス帯を一括で検証する
  it.each([
    ['127.0.0.1', true],
    ['169.254.169.254', true], // クラウドメタデータ (AWS IMDS)
    ['10.0.0.5', true],
    ['172.16.0.1', true],
    ['192.168.1.1', true],
    ['localhost', true],
    ['::1', true],
    ['[::1]', true], // URL 由来の括弧付き表記
    ['0.0.0.0', true],
    ['100.64.0.1', true], // CGNAT
    ['::ffff:127.0.0.1', true], // IPv6-mapped IPv4
    ['example.com', false],
    ['203.0.113.10', false], // パブリック IP (TEST-NET-3)
  ])('%s は %s と判定される', (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });
});

describe('isUnsafeUrl', () => {
  // http (非 TLS) は拒否する
  it('https 以外のスキームは危険と判定する', () => {
    expect(isUnsafeUrl('http://example.com/webhook')).toBe(true);
  });

  // パースできない文字列は fail-closed で危険と判定する
  it('URL としてパースできない文字列は危険と判定する', () => {
    expect(isUnsafeUrl('not a url')).toBe(true);
  });

  // パブリックホストの https は安全と判定する
  it('パブリックホストの https は安全と判定する', () => {
    expect(isUnsafeUrl('https://hooks.slack.com/services/x')).toBe(false);
  });
});

describe('ssrfSafeLookup (DNS リバインディング対策)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // DNS リバインディング攻撃を模擬する: 保存時・送信直前のホスト名検証は通過する
  // パブリックなホスト名が、実際に接続する瞬間には内部 IP (クラウドメタデータ) に
  // 解決されるケース。ホスト名文字列だけの検証では検知できないため、
  // ssrfSafeLookup が「解決された IP そのもの」を見て拒否できることを確認する。
  it('解決先が内部 IP (クラウドメタデータ) なら接続をブロックする', async () => {
    dnsLookupMock.mockImplementation((hostname, options, callback) => {
      callback(null, [{ address: '169.254.169.254', family: 4 }]);
    });

    const result = await new Promise((resolve) => {
      ssrfSafeLookup('rebind-attacker.example.com', {}, (err, address) => {
        resolve({ err, address });
      });
    });

    // 接続前にブロックされ、エラーとして伝播する
    expect((result as { err: Error | null }).err).toBeInstanceOf(Error);
    expect((result as { err: Error }).err.message).toMatch(/SSRFガード/);
  });

  // 複数解決先のうち 1 つでも内部アドレスなら、DNS ラウンドロビン経由の迂回を
  // 防ぐため一括で拒否する (fail-closed)
  it('複数解決先の一部が内部 IP でも一括でブロックする', async () => {
    dnsLookupMock.mockImplementation((hostname, options, callback) => {
      callback(null, [
        { address: '203.0.113.10', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]);
    });

    const result = await new Promise((resolve) => {
      ssrfSafeLookup('mixed.example.com', {}, (err, address) => {
        resolve({ err, address });
      });
    });

    expect((result as { err: Error | null }).err).toBeInstanceOf(Error);
  });

  // 正常系: すべてパブリック IP ならそのまま解決結果を返す
  it('解決先がすべてパブリック IP なら許可する', async () => {
    dnsLookupMock.mockImplementation((hostname, options, callback) => {
      callback(null, [{ address: '203.0.113.10', family: 4 }]);
    });

    const result = await new Promise((resolve) => {
      ssrfSafeLookup('hooks.slack.com', {}, (err, address) => {
        resolve({ err, address });
      });
    });

    expect((result as { err: Error | null }).err).toBeNull();
    expect((result as { address: unknown }).address).toEqual([
      { address: '203.0.113.10', family: 4 },
    ]);
  });

  // DNS 解決自体が失敗した場合は、そのままエラーとして伝播する (握りつぶさない)
  it('DNS 解決の失敗はそのままエラーとして伝播する', async () => {
    const dnsError = new Error('ENOTFOUND');
    dnsLookupMock.mockImplementation((hostname, options, callback) => {
      callback(dnsError, []);
    });

    const result = await new Promise((resolve) => {
      ssrfSafeLookup('nonexistent.example.com', {}, (err) => {
        resolve(err);
      });
    });

    expect(result).toBe(dnsError);
  });

  // 呼び出し元 (undici/Node) が options.all を指定しない場合、dns.lookup は単一アドレス
  // (配列でない) 形式で応答することがある。この形式でも解決先の検証が効くこと、
  // かつ呼び出し元が要求した「単一アドレス」の形式のままコールバックへ返すことを確認する
  // (誤って配列形式に変換してしまうと、呼び出し元が形式の食い違いで壊れる恐れがあるため)。
  it('単一アドレス形式 (options.all 未指定) でも内部 IP を検出してブロックする', async () => {
    dnsLookupMock.mockImplementation((hostname, options, callback) => {
      // dns.lookup は options.all が無いとき (err, address: string, family: number) で返す
      callback(null, '169.254.169.254', 4);
    });

    const result = await new Promise((resolve) => {
      ssrfSafeLookup('rebind-attacker.example.com', {}, (err, address, family) => {
        resolve({ err, address, family });
      });
    });

    expect((result as { err: Error | null }).err).toBeInstanceOf(Error);
    expect((result as { err: Error }).err.message).toMatch(/SSRFガード/);
  });

  // 単一アドレス形式でパブリック IP なら許可し、かつ単一アドレスのまま (配列に変換せず) 返す
  it('単一アドレス形式でパブリック IP なら許可し、形式もそのまま維持する', async () => {
    dnsLookupMock.mockImplementation((hostname, options, callback) => {
      callback(null, '203.0.113.10', 4);
    });

    const result = await new Promise((resolve) => {
      ssrfSafeLookup('hooks.slack.com', {}, (err, address, family) => {
        resolve({ err, address, family });
      });
    });

    expect((result as { err: Error | null }).err).toBeNull();
    // 呼び出し元が単一アドレス形式で受け取った場合、コールバックにも単一アドレス形式で返す
    expect((result as { address: unknown }).address).toBe('203.0.113.10');
    expect((result as { family: unknown }).family).toBe(4);
  });
});
