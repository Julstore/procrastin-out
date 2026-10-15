// Seguridad de feeds RSS y de IP de cliente. Sin dependencias externas.
// Lo usa server.js (y los tests en tests/).
const dns = require('dns').promises;

const MAX_REDIRECTS = 5;

// true si la IP es privada, loopback, link-local, metadata cloud o no válida.
function isPublicIp(ip) {
  if (ip === '::1' || ip === '::' || ip === '::ffff:127.0.0.1') return false;
  if (ip.includes(':')) { // IPv6: solo unicast global 2000::/3
    const first = parseInt(ip.split(':')[0], 16);
    return first >= 0x2000 && first < 0x4000;
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !(n >= 0 && n <= 255))) return false;
  const priv = p[0] === 10 || p[0] === 127 || p[0] === 0
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 192 && p[1] === 168)
    || (p[0] === 169 && p[1] === 254);
  return !priv;
}

// Valida la forma de la URL (http/https, sin credenciales) y que todas sus IPs sean públicas.
// lookup es inyectable para tests.
async function assertPublicFeedUrl(feedUrl, lookup = dns.lookup) {
  let u;
  try { u = new URL(feedUrl); } catch (_) { throw new Error('URL de feed inválida'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('URL de feed inválida');
  if (u.username || u.password) throw new Error('URL de feed inválida');
  let ips = [];
  try { ips = (await lookup(u.hostname, { all: true })).map(r => r.address); }
  catch (_) { throw new Error('No se pudo resolver el feed'); }
  if (!ips.length || ips.some(ip => !isPublicIp(ip))) throw new Error('Feed no permitido (solo hosts públicos)');
  return u;
}

// Descarga un feed siguiendo redirecciones a mano: cada destino vuelve a validarse,
// así una redirección no puede llevar la petición a localhost o a la LAN.
// Devuelve el texto de la respuesta. El timeout cubre también la lectura del cuerpo.
async function fetchPublicFeed(feedUrl, opts = {}) {
  const { timeoutMs = 10000, lookup = dns.lookup, fetchImpl = fetch, headers = {} } = opts;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    let current = feedUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicFeedUrl(current, lookup);
      const r = await fetchImpl(current, {
        redirect: 'manual',
        signal: c.signal,
        headers: { 'User-Agent': 'procrastin-out/1.0 (local)', ...headers },
      });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) {
        if (r.body && typeof r.body.cancel === 'function') await r.body.cancel().catch(() => {});
        current = new URL(loc, current).href;
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    }
    throw new Error('Demasiadas redirecciones');
  } finally { clearTimeout(t); }
}

// Solo links http(s) pasan. Un feed puede traer "javascript:" o "data:" en <link>,
// y eso terminaría en un href del cliente.
function safeHttpUrl(s) {
  try {
    const u = new URL(String(s || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch (_) { return ''; }
}

// IP del cliente para el rate limit. El header X-Forwarded-For solo se usa si el
// servidor corre detrás de un proxy de confianza (TRUST_PROXY=1); si no, cualquiera
// podría falsearlo y evadir el bloqueo por intentos.
function clientIpFrom(req, trustProxy = false) {
  if (trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return (req.socket && req.socket.remoteAddress) || '?';
}

// Quita HTML y normaliza entidades. El desescape va ANTES de quitar etiquetas: los feeds
// escapan el HTML ("&lt;a href...&gt;") y si se quitan etiquetas primero, el HTML queda crudo.
function stripTags(s) {
  const NAMED = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', amp: '&', copy: '©', reg: '®', trade: '™', para: '¶', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', ordf: 'ª', ordm: 'º', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü', iexcl: '¡', iquest: '¿', laquo: '«', raquo: '»', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', deg: '°', euro: '€', times: '×', middot: '·', egrave: 'è', agrave: 'à', ccedil: 'ç', ouml: 'ö', auml: 'ä', szlig: 'ß' };
  const unesc = (x) => x
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => (NAMED[n.toLowerCase()] !== undefined ? NAMED[n.toLowerCase()] : m));
  const out = unesc(String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).replace(/<[^>]*>/g, '');
  return unesc(out).replace(/\s+/g, ' ').trim();
}
// Parsea RSS/Atom: título, link, medio de origen y fecha normalizada (YYYY-MM-DD).
// opts.src = nombre de la plataforma (agrupa en el cliente); opts.feedName = medio por defecto.
function parseRssItems(xml, opts = {}) {
  const max = opts.max || 15;
  const items = [];
  const re = /<(item|entry)[\s>]([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(xml)) && items.length < max) {
    const body = m[2];
    const pick = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(body);
      return r ? stripTags(r[1]) : '';
    };
    let link = pick('link');
    const href = /<link[^>]*href=["']([^"']+)["']/i.exec(body);
    if (href) link = href[1];
    let title = pick('title');
    // Medios: Bing usa News:Source; Google Noticias usa <source> y además termina el título en " - Medio"
    const outlet = pick('News:Source') || pick('source') || opts.feedName || '';
    if (outlet && title.endsWith(' - ' + outlet)) title = title.slice(0, -(outlet.length + 3)).trim();
    if (!title) continue;
    const rawDate = pick('pubDate') || pick('published') || pick('updated') || pick('dc:date');
    const d = rawDate ? new Date(rawDate) : null;
    let snippet = (pick('description') || pick('summary')).slice(0, 220);
    // Si el resumen repite el título (habitual en Google Noticias), no aporta: se omite
    if (snippet && title && snippet.toLowerCase().includes(title.toLowerCase().slice(0, 40))) snippet = '';
    const ts = d && !isNaN(d.getTime()) ? d.getTime() : 0;
    items.push({
      title: title.slice(0, 200),
      url: safeHttpUrl(link),
      src: opts.src || 'RSS',
      outlet: outlet.slice(0, 60),
      date: ts ? d.toISOString().slice(0, 10) : '',
      ts,
      snippet,
    });
  }
  return items;
}

module.exports = {
  isPublicIp,
  assertPublicFeedUrl,
  fetchPublicFeed,
  safeHttpUrl,
  clientIpFrom,
  stripTags,
  parseRssItems,
};
