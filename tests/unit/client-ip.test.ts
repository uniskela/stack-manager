import { describe, expect, it } from 'vitest';
import { clientIpFrom } from '@/server/http/client-ip';

const h = (init: Record<string, string>) => new Headers(init);

describe('clientIpFrom', () => {
  it('ignores forwarding headers unless trusted proxies are configured', () => {
    expect(clientIpFrom(h({ 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4' }), 0)).toBeNull();
  });

  it('takes the N-th address from the right of X-Forwarded-For', () => {
    const headers = h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 10.0.0.2' });
    expect(clientIpFrom(headers, 1)).toBe('10.0.0.2');
    expect(clientIpFrom(headers, 2)).toBe('203.0.113.7');
    expect(clientIpFrom(h({ 'x-forwarded-for': '203.0.113.7' }), 2)).toBeNull();
  });

  it('uses X-Real-IP only behind exactly one trusted proxy, and validates addresses', () => {
    expect(clientIpFrom(h({ 'x-real-ip': '203.0.113.9' }), 1)).toBe('203.0.113.9');
    expect(clientIpFrom(h({ 'x-real-ip': '203.0.113.9' }), 2)).toBeNull();
    expect(clientIpFrom(h({ 'x-forwarded-for': 'not-an-ip' }), 1)).toBeNull();
    expect(clientIpFrom(h({ 'x-forwarded-for': '203.0.113.9:4433' }), 1)).toBe('203.0.113.9');
    expect(clientIpFrom(h({ 'x-forwarded-for': '[2001:DB8::1]:443' }), 1)).toBe('2001:db8::1');
  });
});
