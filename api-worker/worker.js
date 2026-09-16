var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js
import dns from "node:dns";
import { isIP } from "node:net";
var dnsPromises = dns.promises;
var GEO_TTL = 60 * 60 * 24 * 7;
var DNS_TTL = 60 * 10;
var RATE_WINDOW_MS = 6e4;
var RATE_LIMIT = 60;
var clientWindows = /* @__PURE__ */ new Map();
var jsonHeaders = { "content-type": "application/json; charset=UTF-8", "x-content-type-options": "nosniff" };
function response(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { ...jsonHeaders, ...headers } });
}
__name(response, "response");
function error(code, status = 400) {
  return response({ success: false, error: code, timestamp: (/* @__PURE__ */ new Date()).toISOString() }, status);
}
__name(error, "error");
function clientAllowed(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  const window = clientWindows.get(ip);
  if (!window || now - window.startedAt >= RATE_WINDOW_MS) {
    clientWindows.set(ip, { startedAt: now, count: 1 });
    return true;
  }
  window.count += 1;
  return window.count <= RATE_LIMIT;
}
__name(clientAllowed, "clientAllowed");
function normalizeQuery(value) {
  const input = value?.trim();
  if (!input || input.length > 2048) return null;
  if (isIp(input)) return { type: "ip", value: input.toLowerCase() };
  let hostname = input;
  try {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) hostname = new URL(input).hostname;
  } catch {
    return null;
  }
  hostname = hostname.toLowerCase().replace(/\.$/, "");
  if (hostname.length > 253 || !isDomain(hostname)) return null;
  return { type: "domain", value: hostname };
}
__name(normalizeQuery, "normalizeQuery");
function isIp(value) {
  return isIP(value) > 0;
}
__name(isIp, "isIp");
function isIpv4(value) {
  return isIP(value) === 4;
}
__name(isIpv4, "isIpv4");
function isIpv6(value) {
  return isIP(value) === 6;
}
__name(isIpv6, "isIpv6");
function isDomain(value) {
  if (!value.includes(".") || value.length > 253) return false;
  return value.split(".").every((label) => label.length > 0 && label.length <= 63 && /^(?!-)[a-z\d-]+(?<!-)$/.test(label));
}
__name(isDomain, "isDomain");
function isPublicIp(ip) {
  if (isIpv4(ip)) {
    const [a, b, c] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168 || b === 0 && c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (!isIpv6(ip)) return false;
  const normalized = ip.toLowerCase();
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return !(mappedIpv4 ? !isPublicIp(mappedIpv4) : /^(::|::1|ff)/.test(normalized) || /^fe[89ab]/.test(normalized) || /^[fd]/.test(normalized) || /^2001:db8/.test(normalized));
}
__name(isPublicIp, "isPublicIp");
function timeoutFetch(url, options = {}, timeout = 1500) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
}
__name(timeoutFetch, "timeoutFetch");
function normalizeGeo(ip, raw, source) {
  const connection = raw.connection || {};
  const asnNumber = connection.asn || raw.asn?.asn || raw.asn;
  const asn = asnNumber ? String(asnNumber).startsWith("AS") ? String(asnNumber) : `AS${asnNumber}` : null;
  return {
    ip,
    ipVersion: ip.includes(":") ? 6 : 4,
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
    source
  };
}
__name(normalizeGeo, "normalizeGeo");
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
__name(numberOrNull, "numberOrNull");
async function fromIpWho(ip) {
  const result = await timeoutFetch(`https://ipwho.is/${encodeURIComponent(ip)}`);
  if (!result.ok) throw new Error("ipwho unavailable");
  const data = await result.json();
  if (data.success === false) throw new Error("ipwho failed");
  return normalizeGeo(ip, data, "ipwho.is");
}
__name(fromIpWho, "fromIpWho");
async function fromIpApi(ip) {
  const fields = "status,message,country,countryCode,regionName,city,isp,org,as,timezone,lat,lon";
  const result = await timeoutFetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${fields}`);
  if (!result.ok) throw new Error("ip-api unavailable");
  const data = await result.json();
  if (data.status !== "success") throw new Error("ip-api failed");
  const [asn, ...name] = (data.as || "").split(" ");
  return normalizeGeo(ip, { ...data, asn, as_name: name.join(" ") }, "ip-api.com");
}
__name(fromIpApi, "fromIpApi");
async function fromIpinfo(ip, token) {
  if (!token) throw new Error("ipinfo token unavailable");
  const result = await timeoutFetch(`https://api.ipinfo.io/lite/${encodeURIComponent(ip)}?token=${encodeURIComponent(token)}`);
  if (!result.ok) throw new Error("ipinfo unavailable");
  const data = await result.json();
  return normalizeGeo(ip, { country: data.country, country_code: data.country_code, asn: data.asn, as_name: data.as_name }, "IPinfo Lite");
}
__name(fromIpinfo, "fromIpinfo");
async function geoLookup(ip, env, ctx) {
  const key = new Request(`https://cache.internal/geo:v1:${ip}`);
  const cached = await caches.default.match(key);
  if (cached) {
    const createdAt2 = Number(cached.headers.get("x-cache-created-at")) || Date.now();
    return { data: await cached.json(), cached: true, cacheAge: Math.max(0, Math.floor((Date.now() - createdAt2) / 1e3)) };
  }
  let data;
  for (const provider of [() => fromIpWho(ip), () => fromIpApi(ip), () => fromIpinfo(ip, env.IPINFO_TOKEN)]) {
    try {
      data = await provider();
      break;
    } catch {
    }
  }
  if (!data) throw new Error("geo providers failed");
  const createdAt = String(Date.now());
  ctx.waitUntil(caches.default.put(key, response(data, 200, { "cache-control": `public, s-maxage=${GEO_TTL}`, "x-cache-created-at": createdAt })));
  return { data, cached: false, cacheAge: 0 };
}
__name(geoLookup, "geoLookup");
async function safeResolve(method, domain) {
  try {
    return await method(domain);
  } catch {
    return [];
  }
}
__name(safeResolve, "safeResolve");
async function resolveDoh(domain, type) {
  try {
    const result = await timeoutFetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`, { headers: { accept: "application/dns-json" } });
    if (!result.ok) return [];
    const answers = (await result.json()).Answer || [];
    if (type === "MX") return answers.map((answer) => {
      const [priority, exchange] = answer.data.split(/\s+/, 2);
      return { priority: Number(priority), exchange: exchange?.replace(/\.$/, "") };
    }).filter((answer) => answer.exchange);
    if (type === "TXT") return answers.map((answer) => [answer.data.replace(/^"|"$/g, "")]);
    return answers.map((answer) => answer.data.replace(/\.$/, ""));
  } catch {
    return [];
  }
}
__name(resolveDoh, "resolveDoh");
async function resolveDomain(domain, ctx) {
  const key = new Request(`https://cache.internal/dns:v1:${domain}`);
  const cached = await caches.default.match(key);
  if (cached) return { data: await cached.json(), cached: true };
  const [A, AAAA, CNAME, MX, NS, TXT] = await Promise.all([
    safeResolve((name) => dnsPromises.resolve4(name), domain),
    safeResolve((name) => dnsPromises.resolve6(name), domain),
    safeResolve((name) => dnsPromises.resolveCname(name), domain),
    safeResolve((name) => dnsPromises.resolveMx(name), domain),
    safeResolve((name) => dnsPromises.resolveNs(name), domain),
    safeResolve((name) => dnsPromises.resolveTxt(name), domain)
  ]);
  let records = { A, AAAA, CNAME, MX, NS, TXT };
  if (!Object.values(records).some((items) => items.length)) {
    const [dohA, dohAAAA, dohCname, dohMx, dohNs, dohTxt] = await Promise.all(["A", "AAAA", "CNAME", "MX", "NS", "TXT"].map((type) => resolveDoh(domain, type)));
    records = { A: dohA, AAAA: dohAAAA, CNAME: dohCname, MX: dohMx, NS: dohNs, TXT: dohTxt };
  }
  const data = { domain, dns: records };
  if (!Object.values(records).some((items) => items.length)) throw new Error("dns not found");
  ctx.waitUntil(caches.default.put(key, response(data, 200, { "cache-control": `public, s-maxage=${DNS_TTL}` })));
  return { data, cached: false };
}
__name(resolveDomain, "resolveDomain");
async function handleQuery(request, env, ctx) {
  if (request.method !== "GET") return error("METHOD_NOT_ALLOWED", 405);
  if (!clientAllowed(request)) return error("RATE_LIMITED", 429);
  const parsed = normalizeQuery(new URL(request.url).searchParams.get("q"));
  if (!parsed) return error("INVALID_INPUT");
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  try {
    if (parsed.type === "ip") {
      if (!isPublicIp(parsed.value)) return response({ success: true, type: "ip", query: parsed.value, data: { ip: parsed.value, ipVersion: parsed.value.includes(":") ? 6 : 4, privateOrReserved: true, source: "local validation" }, cached: false, cacheAge: 0, timestamp });
      const geo = await geoLookup(parsed.value, env, ctx);
      return response({ success: true, type: "ip", query: parsed.value, data: geo.data, cached: geo.cached, cacheAge: geo.cacheAge, timestamp });
    }
    const domain = await resolveDomain(parsed.value, ctx);
    const addresses = [.../* @__PURE__ */ new Set([...domain.data.dns.A, ...domain.data.dns.AAAA])];
    const limited = [addresses.filter(isIpv4).slice(0, 8), addresses.filter(isIpv6).slice(0, 8)].flat();
    const ips = await Promise.all(limited.map(async (ip) => {
      if (!isPublicIp(ip)) return { ip, privateOrReserved: true, source: "local validation" };
      try {
        return (await geoLookup(ip, env, ctx)).data;
      } catch {
        return { ip, source: "unavailable" };
      }
    }));
    return response({ success: true, type: "domain", query: parsed.value, data: { ...domain.data, ips, limited: addresses.length > limited.length }, cached: domain.cached, timestamp });
  } catch (cause) {
    return error(cause.message === "dns not found" ? "DNS_NOT_FOUND" : "GEO_PROVIDER_FAILED", 502);
  }
}
__name(handleQuery, "handleQuery");
var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/query") return handleQuery(request, env, ctx);
    return env.ASSETS.fetch(request);
  }
};
export {
  worker_default as default,
  isIp,
  isPublicIp,
  normalizeQuery
};
//# sourceMappingURL=worker.js.map
