import dns from 'node:dns';
import { isIP } from 'node:net';

const dnsPromises = dns.promises;
const GEO_TTL = 60 * 60 * 24 * 7;
const DNS_TTL = 60 * 10;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 60;
const clientWindows = new Map();

const jsonHeaders = { 'content-type': 'application/json; charset=UTF-8', 'x-content-type-options': 'nosniff' };

function response(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { ...jsonHeaders, ...headers } });
}

function error(code, status = 400) {
  return response({ success: false, error: code, timestamp: new Date().toISOString() }, status);
}

function clientAllowed(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const now = Date.now();
  const window = clientWindows.get(ip);
  if (!window || now - window.startedAt >= RATE_WINDOW_MS) {
    clientWindows.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  window.count += 1;
  return window.count <= RATE_LIMIT;
}

export function normalizeQuery(value) {
  const input = value?.trim();
  if (!input || input.length > 2048) return null;
  if (isIp(input)) return { type: 'ip', value: input.toLowerCase() };

  let hostname = input;
  try {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) hostname = new URL(input).hostname;
  } catch {
    return null;
  }
  hostname = hostname.toLowerCase().replace(/\.$/, '');
  if (hostname.length > 253 || !isDomain(hostname)) return null;
  return { type: 'domain', value: hostname };
}

export function isIp(value) {
  return isIP(value) > 0;
}

function isIpv4(value) {
  return isIP(value) === 4;
}

function isIpv6(value) {
  return isIP(value) === 6;
}

function isDomain(value) {
  if (!value.includes('.') || value.length > 253) return false;
  return value.split('.').every((label) => label.length > 0 && label.length <= 63 && /^(?!-)[a-z\d-]+(?<!-)$/.test(label));
}

export function isPublicIp(ip) {
  if (isIpv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || (b === 168) || (b === 0 && c === 2))) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (!isIpv6(ip)) return false;
  const normalized = ip.toLowerCase();
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return !(mappedIpv4 ? !isPublicIp(mappedIpv4) : /^(::|::1|ff)/.test(normalized) || /^fe[89ab]/.test(normalized) || /^[fd]/.test(normalized) || /^2001:db8/.test(normalized));
}

function timeoutFetch(url, options = {}, timeout = 1500) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
}

function normalizeGeo(ip, raw, source) {
  const connection = raw.connection || {};
  const asnNumber = connection.asn || raw.asn?.asn || raw.asn;
  const asn = asnNumber ? String(asnNumber).startsWith('AS') ? String(asnNumber) : `AS${asnNumber}` : null;
  return {
    ip,
    ipVersion: ip.includes(':') ? 6 : 4,
    country: raw.country?.name || raw.country || null,
    countryCode: raw.country_code || raw.countryCode || raw.country?.code || null,
    region: raw.region || raw.regionName || null,
    city: raw.city || null,
    isp: connection.isp || raw.isp || raw.org || null,
    asn,
    asName: connection.org || raw.asn?.name || raw.as_name || null,
    organization: connection.org || raw.org || null,
    timezone: raw.timezone?.id || raw.timezone || null,
    latitude: numberOrNull(raw.latitude ?? raw.lat),
    longitude: numberOrNull(raw.longitude ?? raw.lon),
    source,
  };
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

async function fromIpWho(ip) {
  const result = await timeoutFetch(`https://ipwho.is/${encodeURIComponent(ip)}`);
  if (!result.ok) throw new Error('ipwho unavailable');
  const data = await result.json();
  if (data.success === false) throw new Error('ipwho failed');
  return normalizeGeo(ip, data, 'ipwho.is');
}

async function fromTechnikNews(ip) {
  const result = await timeoutFetch(`https://api.techniknews.net/ipgeo/${encodeURIComponent(ip)}`);
  if (!result.ok) throw new Error('techniknews unavailable');
  const data = await result.json();
  if (data.status !== 'success') throw new Error('techniknews failed');
  const [asn, ...asName] = (data.as || '').split(' ');
  return normalizeGeo(ip, { ...data, asn, as_name: asName.join(' ') }, 'IPGEO / TechnikNews');
}

async function fromGeoJs(ip) {
  const result = await timeoutFetch(`https://get.geojs.io/v1/ip/geo/${encodeURIComponent(ip)}.json`);
  if (!result.ok) throw new Error('geojs unavailable');
  const data = await result.json();
  if (!data.ip) throw new Error('geojs failed');
  return normalizeGeo(ip, { ...data, country_code: data.country_code, asn: data.asn, as_name: data.organization_name, isp: data.organization }, 'GeoJS');
}

async function fromIpApi(ip) {
  const fields = 'status,message,country,countryCode,regionName,city,isp,org,as,timezone,lat,lon';
  const result = await timeoutFetch(`https://ip-api.com/json/${encodeURIComponent(ip)}?fields=${fields}`);
  if (!result.ok) throw new Error('ip-api unavailable');
  const data = await result.json();
  if (data.status !== 'success') throw new Error('ip-api failed');
  const [asn, ...name] = (data.as || '').split(' ');
  return normalizeGeo(ip, { ...data, asn, as_name: name.join(' ') }, 'ip-api.com');
}

async function fromIpinfoPublic(ip) {
  const result = await timeoutFetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json`);
  if (!result.ok) throw new Error('ipinfo unavailable');
  const data = await result.json();
  const [latitude, longitude] = (data.loc || '').split(',').map(Number);
  const [asn, ...asName] = (data.org || '').split(' ');
  return normalizeGeo(ip, { ...data, country_code: data.country, asn, as_name: asName.join(' '), latitude, longitude }, 'ipinfo.io');
}

async function fromIpinfo(ip, token) {
  if (!token) throw new Error('ipinfo token unavailable');
  const result = await timeoutFetch(`https://api.ipinfo.io/lite/${encodeURIComponent(ip)}?token=${encodeURIComponent(token)}`);
  if (!result.ok) throw new Error('ipinfo unavailable');
  const data = await result.json();
  return normalizeGeo(ip, { country: data.country, country_code: data.country_code, asn: data.asn, as_name: data.as_name }, 'IPinfo Lite');
}

async function geoLookup(ip, env, ctx) {
  const key = new Request(`https://cache.internal/geo:v1:${ip}`);
  const cached = await caches.default.match(key);
  if (cached) {
    const createdAt = Number(cached.headers.get('x-cache-created-at')) || Date.now();
    return { data: await cached.json(), cached: true, cacheAge: Math.max(0, Math.floor((Date.now() - createdAt) / 1000)) };
  }
  let data;
  for (const provider of [() => fromTechnikNews(ip), () => fromIpWho(ip), () => fromIpinfoPublic(ip), () => fromGeoJs(ip), () => fromIpApi(ip), () => fromIpinfo(ip, env.IPINFO_TOKEN)]) {
    try { data = await provider(); break; } catch { /* use the next provider */ }
  }
  if (!data) throw new Error('geo providers failed');
  const createdAt = String(Date.now());
  ctx.waitUntil(caches.default.put(key, response(data, 200, { 'cache-control': `public, s-maxage=${GEO_TTL}`, 'x-cache-created-at': createdAt })));
  return { data, cached: false, cacheAge: 0 };
}

async function safeResolve(method, domain) {
  try { return await method(domain); } catch { return []; }
}

async function resolveDoh(domain, type) {
  try {
    const result = await timeoutFetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`, { headers: { accept: 'application/dns-json' } });
    if (!result.ok) return [];
    const answers = (await result.json()).Answer || [];
    if (type === 'MX') return answers.map((answer) => { const [priority, exchange] = answer.data.split(/\s+/, 2); return { priority: Number(priority), exchange: exchange?.replace(/\.$/, '') }; }).filter((answer) => answer.exchange);
    if (type === 'TXT') return answers.map((answer) => [answer.data.replace(/^"|"$/g, '')]);
    return answers.map((answer) => answer.data.replace(/\.$/, ''));
  } catch { return []; }
}

async function resolveDomain(domain, ctx) {
  const key = new Request(`https://cache.internal/dns:v1:${domain}`);
  const cached = await caches.default.match(key);
  if (cached) return { data: await cached.json(), cached: true };
  const [A, AAAA, CNAME, MX, NS, TXT] = await Promise.all([
    safeResolve((name) => dnsPromises.resolve4(name), domain), safeResolve((name) => dnsPromises.resolve6(name), domain), safeResolve((name) => dnsPromises.resolveCname(name), domain),
    safeResolve((name) => dnsPromises.resolveMx(name), domain), safeResolve((name) => dnsPromises.resolveNs(name), domain), safeResolve((name) => dnsPromises.resolveTxt(name), domain),
  ]);
  let records = { A, AAAA, CNAME, MX, NS, TXT };
  // Native node:dns is preferred. DoH keeps the endpoint useful in local runtimes
  // where node:dns is unavailable, without ever fetching a user-provided URL.
  if (!Object.values(records).some((items) => items.length)) {
    const [dohA, dohAAAA, dohCname, dohMx, dohNs, dohTxt] = await Promise.all(['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT'].map((type) => resolveDoh(domain, type)));
    records = { A: dohA, AAAA: dohAAAA, CNAME: dohCname, MX: dohMx, NS: dohNs, TXT: dohTxt };
  }
  const data = { domain, dns: records };
  if (!Object.values(records).some((items) => items.length)) throw new Error('dns not found');
  ctx.waitUntil(caches.default.put(key, response(data, 200, { 'cache-control': `public, s-maxage=${DNS_TTL}` })));
  return { data, cached: false };
}

async function mapWithConcurrency(items, limit, mapper) {
  const output = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      output[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

async function handleQuery(request, env, ctx) {
  if (request.method !== 'GET') return error('METHOD_NOT_ALLOWED', 405);
  if (!clientAllowed(request)) return error('RATE_LIMITED', 429);
  const parsed = normalizeQuery(new URL(request.url).searchParams.get('q'));
  if (!parsed) return error('INVALID_INPUT');
  const timestamp = new Date().toISOString();
  try {
    if (parsed.type === 'ip') {
      if (!isPublicIp(parsed.value)) return response({ success: true, type: 'ip', query: parsed.value, data: { ip: parsed.value, ipVersion: parsed.value.includes(':') ? 6 : 4, privateOrReserved: true, source: 'local validation' }, cached: false, cacheAge: 0, timestamp });
      const geo = await geoLookup(parsed.value, env, ctx);
      return response({ success: true, type: 'ip', query: parsed.value, data: geo.data, cached: geo.cached, cacheAge: geo.cacheAge, timestamp });
    }
    const domain = await resolveDomain(parsed.value, ctx);
    const addresses = [...new Set([...domain.data.dns.A, ...domain.data.dns.AAAA])];
    const limited = [addresses.filter(isIpv4).slice(0, 8), addresses.filter(isIpv6).slice(0, 8)].flat();
    const ips = await mapWithConcurrency(limited, 2, async (ip) => {
      if (!isPublicIp(ip)) return { ip, privateOrReserved: true, source: 'local validation' };
      try { return (await geoLookup(ip, env, ctx)).data; } catch { return { ip, source: 'unavailable' }; }
    });
    return response({ success: true, type: 'domain', query: parsed.value, data: { ...domain.data, ips, limited: addresses.length > limited.length }, cached: domain.cached, timestamp });
  } catch (cause) {
    return error(cause.message === 'dns not found' ? 'DNS_NOT_FOUND' : 'GEO_PROVIDER_FAILED', 502);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/query') return handleQuery(request, env, ctx);
    return env.ASSETS.fetch(request);
  },
};
