/** Public HTTPS only. DNS resolution cannot be checked reliably in Workers: use an
 * egress firewall/allowlist if administrators or feed DNS are not trusted. */
export function assertPublicHttpsUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Only credential-free HTTPS on port 443 is allowed');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(host)) throw new Error('Non-public host rejected');
  // Conservatively reject IPv6 literals (including IPv4-mapped addresses).
  if (host.includes(':') || host.startsWith('[')) throw new Error('IP literal rejected');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a,b,c] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) throw new Error('Non-public IP rejected');
  }
  return url;
}

export async function fetchBounded(url: string, init: RequestInit = {}, maxBytes = 1_000_000, timeoutMs = 10_000, fetcher: typeof fetch = fetch): Promise<{response: Response; text: string}> {
  const validated = assertPublicHttpsUrl(url);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid fetch limits');
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  init.signal?.addEventListener('abort', abort, { once: true });
  if (init.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error('Fetch timeout')), timeoutMs);
  // Enforce the deadline even for a custom transport that ignores AbortSignal.
  const withinDeadline = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const signal = controller.signal;
    const onAbort = () => reject(signal.reason || new Error('Fetch aborted'));
    if (signal.aborted) { operation.catch(() => {}); onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await withinDeadline(fetcher(validated.href, { ...init, redirect: 'manual', signal: controller.signal }));
    if (response.status >= 300 && response.status < 400 && response.status !== 304) { void response.body?.cancel().catch(() => {}); throw new Error('Feed redirects are not allowed'); }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) { void response.body?.cancel().catch(() => {}); throw new Error('Response exceeds byte limit'); }
    if (!response.body) return { response, text: '' };
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '', bytes = 0;
    while (true) {
      const chunk = await withinDeadline(reader.read());
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) { void reader.cancel().catch(() => {}); throw new Error('Response exceeds byte limit'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { response, text };
  } catch (error) {
    void reader?.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', abort);
    reader?.releaseLock();
  }
}
