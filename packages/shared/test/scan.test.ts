import { describe, expect, it } from 'vitest';

import {
  REDACTED,
  normalizeSecrets,
  redactDiagnostics,
  redactText,
  scanText,
} from '../src/scan.ts';

const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEA0000000000000000000000000000000000000000',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

describe('scanText', () => {
  it('对干净文本返回空数组', () => {
    expect(scanText('分析结论没有任何凭据。')).toEqual([]);
  });

  it('识别短前缀凭据', () => {
    expect(scanText('key=sk-abcdefghijklmnop1234')).toEqual(['sk-']);
    expect(scanText('key=github_pat_abcdefghijklmnopqrstuvwxyz')).toEqual(['github_pat_']);
    expect(scanText('key=ghp_abcdefghijklmnopqrstuvwxyz')).toEqual(['ghp_']);
  });

  it('识别 Bearer 与私钥头', () => {
    expect(scanText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toEqual(['bearer']);
    expect(scanText(PEM)).toEqual(['private-key']);
  });

  it('精确值命中给出 exact-secret', () => {
    const secret = 'custom-secret-value-123';
    expect(scanText(`prefix ${secret} suffix`, [secret])).toEqual(['exact-secret']);
  });

  it('同时命中多类时按固定顺序返回', () => {
    const text = `sk-abcdefghijklmnop1234 Bearer abcdefghijklmnopqrstuvwxyz`;
    expect(scanText(text)).toEqual(['sk-', 'bearer']);
  });
});

describe('normalizeSecrets', () => {
  it('过滤过短值、去重并按长度降序', () => {
    expect(normalizeSecrets(['short', 'aaaaaaaaaa', 'bbbbbbbbbbbb', 'aaaaaaaaaa'])).toEqual([
      'bbbbbbbbbbbb',
      'aaaaaaaaaa',
    ]);
  });
});

describe('redactText', () => {
  it('私钥整块替换，不留 base64 主体', () => {
    expect(redactText(PEM)).toBe(REDACTED);
  });

  it('缺失 END 的半截私钥块吞到文末', () => {
    expect(redactText('-----BEGIN PRIVATE KEY-----\nAAAA')).toBe(REDACTED);
  });

  it('私钥块之后的正文保留', () => {
    expect(redactText(`${PEM}\n后续说明`)).toBe(`${REDACTED}\n后续说明`);
  });

  it('精确值先长后短，避免长值被切碎', () => {
    const long = 'secret-value-extended';
    const short = 'secret-value';
    const cleaned = redactText(`x ${long} y`, [short, long]);
    expect(cleaned).toBe(`x ${REDACTED} y`);
  });

  it('替换短前缀与 Bearer', () => {
    expect(redactText('sk-abcdefghijklmnop1234')).toBe(REDACTED);
    expect(redactText('Bearer abcdefghijklmnopqrstuvwxyz')).toBe(REDACTED);
  });

  it('保留普通文本', () => {
    expect(redactText('没有凭据')).toBe('没有凭据');
  });
});

describe('redactDiagnostics', () => {
  it('脱敏路径、IP 与 UUID', () => {
    const text =
      'C:\\Users\\dev\\repo\\a.ts /home/dev/b.ts 192.168.1.10 550e8400-e29b-41d4-a716-446655440000';
    expect(redactDiagnostics(text)).toBe('<path> <path> <ip> <uuid>');
  });
});
