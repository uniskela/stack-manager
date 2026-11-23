import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { resolveAllowedHost, type Resolver } from './network-policy';

export async function readHttps(
  url: URL,
  options: {
    headers: Record<string, string>;
    allowPrivateNetworks: boolean;
    resolver?: Resolver;
    signal: AbortSignal;
    maxBytes: number;
  },
): Promise<{ status: number; body: Buffer }> {
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('HTTPS required');
  const { signal } = options;
  signal.throwIfAborted();
  const addresses = await new Promise<string[]>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    resolveAllowedHost(url.hostname, options)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
  signal.throwIfAborted();
  const address = addresses[0]!;
  const lookup: LookupFunction = (_hostname, requested, callback) => {
    const family = isIP(address);
    if (requested.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
  const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const request = https.get(
      url,
      { agent: false, lookup, signal, maxHeaderSize: 16_384, headers: options.headers },
      resolve,
    );
    request.on('error', reject);
  });
  const status = response.statusCode ?? 0;
  if (status !== 200) {
    response.destroy();
    return { status, body: Buffer.alloc(0) };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > options.maxBytes) {
      response.destroy();
      throw new Error('Response exceeds the allowed size');
    }
    chunks.push(chunk);
  }
  return { status, body: Buffer.concat(chunks, size) };
}
