// ==UserScript==
// @name         Warframe Monitor
// @namespace    beto.wfmarket.pricealert
// @version      3.3.3
// @description  Monitora itens, Rivens, Kuva Liches e Sisters, com filtros e alertas no Discord.
// @author       Beto
// @match        https://warframe.market/*
// @match        https://*.warframe.market/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getResourceURL
// @grant        GM_registerMenuCommand
// @resource     wmIcon https://raw.githubusercontent.com/Betguin/warframe-monitor/main/icon.png
// @icon         https://raw.githubusercontent.com/Betguin/warframe-monitor/main/icon.png
// @homepageURL  https://github.com/Betguin/warframe-monitor
// @updateURL    https://raw.githubusercontent.com/Betguin/warframe-monitor/main/warframe-monitor.user.js
// @downloadURL  https://raw.githubusercontent.com/Betguin/warframe-monitor/main/warframe-monitor.user.js
// @connect      api.warframe.market
// @connect      discord.com
// @connect      discordapp.com
// @noframes
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';
  const BRAND_ICON = GM_getResourceURL('wmIcon');

  // Itens e catálogos: API v2. Busca de contratos: API v1, ainda usada pelo site.
  const API = 'https://api.warframe.market';
  const PREFIX = 'wfpa_v3_monitor_';
  const WEBHOOK = 'wfpa_webhook_url';
  const INTERVAL = 120000;
  const CONTRACT_GAP = 6500; // Menos de 10 buscas de contratos/minuto por monitor executor.
  const KINDS = { item: 'Item comum', riven: 'Riven', lich: 'Kuva Lich', sister: 'Sister' };
  const ELEMENTS = { cold: 'Frio', electricity: 'Eletricidade', heat: 'Calor', impact: 'Impacto', magnetic: 'Magnético', radiation: 'Radiação', toxin: 'Toxina' };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const num = v => v === null || v === undefined || String(v).trim() === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
  const nameOf = e => e?.i18n?.pt?.name || e?.i18n?.en?.name || e?.slug || '';
  const titleOf = s => String(s || '').replace(/_/g, ' ');
  const uid = () => crypto.randomUUID();
  const getMonitor = id => GM_getValue(PREFIX + id, null);
  const putMonitor = m => GM_setValue(PREFIX + m.id, m);
  const monitors = () => GM_listValues().filter(k => k.startsWith(PREFIX)).map(k => GM_getValue(k)).filter(m => m && KINDS[m.kind]);
  const activeMonitors = () => monitors().filter(m => m.active);
  function identity(m) {
    const f = Object.fromEntries(Object.entries(m.filters || {}).sort(([a], [b]) => a.localeCompare(b)));
    return JSON.stringify([m.kind, m.slug, f, m.platform, m.crossplay, m.status, m.priceMode]);
  }
  const clean = v => String(v ?? '').replace(/[`\r\n]/g, ' ').slice(0, 800);
  const escapeMd = v => clean(v).replace(/[\\*_~|<>\[\]]/g, '\\$&');
  let requestChain = Promise.resolve(), nextRequest = 0, nextContract = 0, apiBackoff = 0, discordBackoff = 0;
  let root, statusNode, listNode, editing = null, formGeneration = 0, uiSignature = '';
  const catalogs = new Map();
  const INSTANCE = uid();
  let leader = false;
  let pageKey = '', contextGeneration = 0;
  let lastSiteMarket = null;
  let formCatalog = [];

  function siteMarket(href = location.href) {
    const u = new URL(href);
    const normalize = p => p === 'ps' ? 'ps4' : p;
    const known = ['pc', 'ps4', 'xbox', 'switch', 'mobile'];
    // O site atual muda de plataforma sem trocar a URL. Desktop/mobile
    // podem renderizar cópias do seletor; considere a seleção efetiva.
    const selected = [...document.querySelectorAll('input[type="radio"][name^="platform-"]')]
      .filter(e => e.checked).map(e => normalize(e.name.slice('platform-'.length))).filter(p => known.includes(p)).at(-1);
    const toggle = [...document.querySelectorAll('input[id="filter-crossplay"]')].at(-1);
    const host = normalize(u.hostname.split('.')[0]);
    const fallback = known.includes(host) ? host : 'pc';
    const remembered = lastSiteMarket?.host === u.hostname ? lastSiteMarket : null;
    const market = { platform: selected || remembered?.platform || fallback,
      crossplay: toggle ? toggle.checked : remembered?.crossplay ?? false };
    lastSiteMarket = { ...market, host: u.hostname };
    return market;
  }

  function validWebhook(value) {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && ['discord.com', 'discordapp.com'].includes(u.hostname)
        && !u.username && !u.password && !u.port
        && /^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+\/?$/.test(u.pathname) && !u.search && !u.hash;
    } catch { return false; }
  }

  function http(url, { method = 'GET', body, platform = 'pc', crossplay = false } = {}) {
    return new Promise((resolve, reject) => {
      const isApi = new URL(url).hostname === 'api.warframe.market';
      GM_xmlhttpRequest({
        method, url, timeout: 20000, anonymous: true,
        headers: isApi ? { Accept: 'application/json', Language: 'pt', Platform: platform, Crossplay: String(crossplay) }
          : { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { data: JSON.stringify(body) }),
        onload: r => {
          let data = null;
          try { data = r.responseText ? JSON.parse(r.responseText) : null; } catch { /* Validar abaixo. */ }
          if (r.status < 200 || r.status >= 300) {
            const e = new Error(`${isApi ? 'Warframe Market' : 'Discord'}: HTTP ${r.status}${r.status === 400 ? ' — confira os filtros da busca.' : ''}`);
            e.status = r.status;
            const header = /(?:^|\n)retry-after:\s*([^\r\n]+)/i.exec(r.responseHeaders || '')?.[1];
            const retry = num(data?.retry_after) ?? num(header);
            e.retryMs = Math.max(60000, retry === null ? 0 : retry * 1000);
            if (r.status === 429 || r.status === 509) {
              if (isApi) apiBackoff = Date.now() + e.retryMs;
              else discordBackoff = Date.now() + e.retryMs;
            }
            reject(e); return;
          }
          if (isApi && (!data || data.error)) { reject(new Error('Resposta inválida da API.')); return; }
          resolve(data);
        },
        onerror: () => reject(new Error('Falha de rede. A consulta será tentada novamente.')),
        ontimeout: () => reject(new Error('Tempo limite de 20 segundos excedido.')),
        onabort: () => reject(new Error('Consulta cancelada.')),
      });
    });
  }

  function apiGet(path, monitor = {}) {
    const task = requestChain.catch(() => {}).then(async () => {
      const contract = path.startsWith('/v1/auctions/');
      await sleep(Math.max(0, nextRequest - Date.now(), apiBackoff - Date.now(), contract ? nextContract - Date.now() : 0));
      nextRequest = Date.now() + 450;
      if (contract) nextContract = Date.now() + CONTRACT_GAP;
      return http(API + path, { platform: monitor.platform || 'pc', crossplay: monitor.crossplay === true });
    });
    requestChain = task;
    return task;
  }

  async function catalog(path) {
    if (catalogs.has(path)) return catalogs.get(path);
    const key = 'wfpa_v3_catalog_' + path;
    const cached = GM_getValue(key, null);
    if (cached?.time > Date.now() - 86400000 && Array.isArray(cached.data)) return cached.data;
    const pending = apiGet('/v2/' + path).then(result => {
      if (!Array.isArray(result?.data)) throw new Error('Catálogo inesperado: ' + path);
      GM_setValue(key, { time: Date.now(), data: result.data });
      return result.data;
    }).finally(() => catalogs.delete(path));
    catalogs.set(path, pending);
    return pending;
  }

  function queryFor(m) {
    const q = new URLSearchParams({ type: m.kind, weapon_url_name: m.slug, sort_by: 'price_asc' });
    const f = m.filters || {};
    if (m.priceMode !== 'buyout') q.set('buyout_policy', 'direct');
    if (m.kind === 'riven') {
      if (f.positive?.length) q.set('positive_stats', f.positive.join(','));
      if (f.negative) q.set('negative_stats', f.negative);
      if (f.polarity) q.set('polarity', f.polarity);
      if (f.maxed) q.set('mod_rank', 'maxed');
      for (const k of ['mastery_rank_min', 'mastery_rank_max', 're_rolls_min', 're_rolls_max']) if (num(f[k]) !== null) q.set(k, f[k]);
    } else {
      if (f.element) q.set('element', f.element);
      if (f.ephemera === 'true' || f.ephemera === 'false') q.set('has_ephemera', f.ephemera);
      if (f.quirk) q.set('quirk', f.quirk);
      for (const k of ['damage_min', 'damage_max']) if (num(f[k]) !== null) q.set(k, f[k]);
    }
    return q;
  }

  function searchUrl(m) {
    const host = m.platform === 'pc' ? 'warframe.market' : m.platform + '.warframe.market';
    return m.kind === 'item' ? `https://${host}/items/${encodeURIComponent(m.slug)}`
      : `https://${host}/auctions/search?${queryFor(m)}`;
  }

  function inRange(value, min, max) {
    const n = num(value), lo = num(min), hi = num(max);
    return (lo === null && hi === null) || (n !== null && (lo === null || n >= lo) && (hi === null || n <= hi));
  }

  function matchesContract(a, m) {
    const i = a.item, f = m.filters || {};
    if (!i || i.type !== m.kind || i.weapon_url_name !== m.slug || a.closed !== false || a.visible !== true || a.private === true || a.winner || a.is_marked_for) return false;
    if (m.kind === 'riven') {
      if (!Array.isArray(i.attributes)) return false;
      const pos = i.attributes.filter(x => x.positive === true).map(x => x.url_name);
      const neg = i.attributes.filter(x => x.positive === false).map(x => x.url_name);
      if ((f.positive || []).some(x => !pos.includes(x))) return false;
      if (f.negative === 'has' && !neg.length) return false;
      if (f.negative === 'none' && neg.length) return false;
      if (f.negative && !['has', 'none'].includes(f.negative) && !neg.includes(f.negative)) return false;
      if (f.polarity && i.polarity !== f.polarity) return false;
      if (f.maxed && num(i.mod_rank) !== 8) return false;
      return inRange(i.mastery_level, f.mastery_rank_min, f.mastery_rank_max) && inRange(i.re_rolls, f.re_rolls_min, f.re_rolls_max);
    }
    return (!f.element || i.element === f.element)
      && (!f.quirk || i.quirk === f.quirk)
      && (f.ephemera === '' || f.ephemera === undefined || i.having_ephemera === (f.ephemera === 'true'))
      && inRange(i.damage, f.damage_min, f.damage_max);
  }

  function contractPrice(a, mode) {
    // Nunca usar top_bid ou starting_price de um leilão como preço de compra.
    if (mode !== 'buyout' && a.is_direct_sell !== true) return null;
    const buyout = num(a.buyout_price);
    if (buyout !== null && buyout > 0) return buyout;
    const direct = a.is_direct_sell === true ? num(a.starting_price) : null;
    return direct !== null && direct > 0 ? direct : null;
  }

  function allowedStatus(status, wanted) {
    return wanted === 'all' ? ['ingame', 'online', 'offline'].includes(status)
      : wanted === 'online' ? ['ingame', 'online'].includes(status) : status === 'ingame';
  }

  function offersFrom(data, m) {
    const result = [];
    const source = m.kind === 'item' ? data?.data : data?.payload?.auctions;
    if (!Array.isArray(source)) throw new Error('Formato da resposta mudou; monitor preservado, sem emitir alertas.');
    for (const a of source) {
      const owner = m.kind === 'item' ? a.user : a.owner;
      if (!owner || owner.banned === true) continue;
      let price;
      if (m.kind === 'item') {
        if (a.type !== 'sell' || a.visible !== true || !inRange(a.rank, m.filters?.rank, m.filters?.rank)) continue;
        price = num(a.platinum);
      } else {
        if (!matchesContract(a, m)) continue;
        price = contractPrice(a, m.priceMode);
      }
      if (price === null || price < 0 || !a.id) continue;
      const seller = owner.ingameName || owner.ingame_name;
      if (!seller) continue;
      // Plataforma/crossplay são filtrados pela API através dos headers.
      result.push({ id: a.id, price, seller, profileSlug: owner.slug || owner.url_name || null, status: owner.status, item: a.item || {}, rank: num(a.rank), direct: a.is_direct_sell === true,
        url: m.kind === 'item' ? searchUrl(m) : `https://warframe.market/auction/${encodeURIComponent(a.id)}` });
    }
    return result.sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));
  }

  function describeOffer(o, m) {
    if (m.kind === 'item') return o.rank === null ? m.name : `${m.name} (Rank ${o.rank})`;
    if (m.kind === 'riven') return `${m.name} ${o.item.name || ''} · Rank ${o.item.mod_rank} · MR ${o.item.mastery_level} · ${o.item.re_rolls} rolagens`;
    return `${m.name} · ${o.item.damage}% ${ELEMENTS[o.item.element] || o.item.element} · ${o.item.having_ephemera ? 'com' : 'sem'} efêmera`;
  }

  function alertEmbed(o, m) {
    const name = describeOffer(o, m);
    const itemText = m.kind === 'riven' ? `${m.name} ${o.item.name || ''}` : name;
    const whisper = m.kind === 'riven'
      ? `/w ${clean(o.seller)} Hi! Is your ${clean(itemText).trim()} Riven still available for ${o.price} platinum?`
      : `/w ${clean(o.seller)} Hi! I'd like to buy your ${clean(itemText)} for ${o.price} platinum.`;
    const attrs = m.kind === 'riven' ? (o.item.attributes || []).map(a => escapeMd(`${a.positive ? '+' : '−'} ${Math.abs(a.value)} ${titleOf(a.url_name)}`)).join('\n').slice(0, 1000) : '';
    const status = { ingame: '🟢 No jogo', online: '🔵 No site', offline: '⚪ Offline' }[o.status] || 'Status indisponível';
    const difference = Math.max(0, m.threshold - o.price);
    return {
      author: { name: 'Warframe Monitor', icon_url: 'https://raw.githubusercontent.com/Betguin/warframe-monitor/main/icon.png' },
      title: `${m.name} · ${o.price} plat`.slice(0, 256), color: m.kind === 'riven' ? 0xa879f5 : 0x00b8a9, url: o.url,
      description: `**${escapeMd(name)}**${attrs ? '\n\n' + attrs : ''}\n\n**Mensagem no jogo**\n\`\`\`\n${whisper}\n\`\`\``,
      fields: [
        { name: '💎 Preço', value: `**${o.price} plat**`, inline: true },
        { name: 'Seu limite', value: `${m.threshold} plat\n${difference ? `${difference} plat abaixo` : 'Dentro do limite'}`, inline: true },
        { name: 'Vendedor', value: `${escapeMd(o.seller)}\n${status}`, inline: true },
      ], footer: { text: `Warframe Monitor · ${m.platform}${m.crossplay ? ' + crossplay' : ''}${m.kind !== 'item' && !o.direct ? ' · compra imediata de leilão' : ''}` },
      timestamp: new Date().toISOString(),
    };
  }

  function alertPayload(o, m) {
    const links = [{ type: 2, style: 5, label: 'Ver oferta', url: o.url }];
    if (o.profileSlug) links.push({ type: 2, style: 5, label: 'Ver vendedor', url: `https://warframe.market/profile/${encodeURIComponent(o.profileSlug)}` });
    return { allowed_mentions: { parse: [] }, embeds: [alertEmbed(o, m)], components: [{ type: 1, components: links }] };
  }

  function testPayload(kind) {
    if (!Object.hasOwn(KINDS, kind)) throw new Error('Categoria de teste inválida.');
    const samples = {
      item: { name: 'Serration', slug: 'serration', price: 10, threshold: 20 },
      riven: { name: 'Torid', slug: 'torid', price: 20, threshold: 50 },
      lich: { name: 'Kuva Nukor', slug: 'kuva_nukor', price: 80, threshold: 100 },
      sister: { name: 'Tenet Cycron', slug: 'tenet_cycron', price: 90, threshold: 120 },
    };
    const sample = samples[kind];
    const m = { ...sample, kind, platform: 'pc', crossplay: true, filters: {}, priceMode: 'direct' };
    const o = { price: sample.price, seller: 'VENDEDOR_EXEMPLO', status: 'ingame', rank: 10, direct: true, url: searchUrl(m),
      item: { name: 'Crita-visican', mod_rank: 8, mastery_level: 12, re_rolls: 5, damage: 55, element: 'toxin', having_ephemera: true,
        attributes: [{ positive: true, value: 170, url_name: 'critical_chance' }, { positive: true, value: 120, url_name: 'damage' }, { positive: false, value: -30, url_name: 'zoom' }] } };
    const payload = alertPayload(o, m), embed = payload.embeds[0];
    embed.title = `[TESTE] ${embed.title}`;
    embed.description = '**Exemplo fictício — não é uma oferta real.**\n\n' + embed.description;
    embed.footer.text = 'Warframe Monitor · TESTE · Nenhum monitor foi alterado';
    // Não direcionar o usuário a um vendedor ou anúncio fictício.
    delete embed.url;
    delete payload.components;
    return payload;
  }

  function buildTestMenu(settings) {
    const section = disclosure('Modo de testes', 'test-menu');
    section.hidden = !GM_getValue('wfpa_dev_mode', false);
    section.append(el('p', 'Exemplos fictícios. Envie uma prévia ao webhook preenchido nas configurações.', { class: 'muted' }));
    section.append(field('Exemplo de alerta', 'test-kind', Object.entries(KINDS)));
    const category = section.querySelector('#test-kind');
    const preview = el('pre', '', { id: 'test-preview', style: 'white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 inherit;background:#0e191e;padding:10px;border-radius:6px' });
    section.append(preview);
    const refresh = () => {
      const e = testPayload(category.value).embeds[0];
      preview.textContent = `${e.title}\n\n${e.description}\n\n${e.fields.map(f => `${f.name}: ${f.value}`).join('\n')}\n\n${e.footer.text}`;
    };
    const send = button('Enviar exemplo ao Discord', async () => {
      if (!GM_getValue('wfpa_dev_mode', false) || send.disabled) return;
      const webhook = val('webhook').trim();
      if (!validWebhook(webhook)) return setStatus('Preencha um webhook válido nas configurações.', true);
      const payload = testPayload(category.value);
      send.disabled = true;
      try {
        await sleep(Math.max(0, discordBackoff - Date.now()));
        await http(`${webhook}?wait=true`, { method: 'POST', body: payload });
        setStatus('Exemplo enviado ao Discord. Seus monitores não foram alterados.');
      } catch (e) { setStatus(e.message, true); }
      finally { await sleep(1200); send.disabled = false; }
    });
    section.append(send);
    settings.append(section);
    category.addEventListener('change', refresh);
    refresh();
    GM_registerMenuCommand('Warframe Monitor: ativar/desativar modo de testes', () => {
      const enabled = !GM_getValue('wfpa_dev_mode', false);
      GM_setValue('wfpa_dev_mode', enabled);
      section.hidden = !enabled;
      if (enabled) {
        $('panel').hidden = false; $('fab').setAttribute('aria-expanded', 'true');
        settings.hidden = false; settings.open = true; section.open = true;
      }
      setStatus(enabled ? 'Modo de testes ativado neste Tampermonkey.' : 'Modo de testes desativado.');
    });
  }

  async function notifyOffers(m, offers) {
    const previous = m.notified || {};
    const eligible = offers.filter(o => o.price <= m.threshold && allowedStatus(o.status, m.status));
    const fresh = eligible.filter(o => previous[o.id] !== o.price);
    const webhook = GM_getValue(WEBHOOK, '');
    if (fresh.length && !validWebhook(webhook)) throw new Error('Salve um webhook válido no painel.');
    // Conservar o histórico mesmo quando uma oferta some dos resultados limitados
    // da API. Só alertar novamente se o preço dessa oferta mudar.
    for (let offset = 0; offset < fresh.length; offset += 10) {
      const batch = fresh.slice(offset, offset + 10);
      // Um embed por mensagem: descrições de Rivens podem atingir o limite agregado do Discord.
      for (const o of batch) {
        const latest = getMonitor(m.id);
        if (!latest?.active || latest.revision !== m.revision || !leader) return;
        await sleep(Math.max(0, discordBackoff - Date.now()));
        const beforeSend = getMonitor(m.id);
        if (!beforeSend?.active || beforeSend.revision !== m.revision || !leader) return;
        await http(`${webhook}?wait=true&with_components=true`, { method: 'POST', body: alertPayload(o, m) });
        const after = getMonitor(m.id);
        if (!after || after.revision !== m.revision) return;
        after.notified = { ...(after.notified || {}), [o.id]: o.price };
        // Limite de armazenamento; conserva as 5000 ofertas notificadas mais recentes.
        if (Object.keys(after.notified).length > 5000) delete after.notified[Object.keys(after.notified)[0]];
        putMonitor(after);
        await sleep(1200);
      }
    }
  }

  async function checkMonitor(m) {
    try {
      const data = await apiGet(m.kind === 'item' ? `/v2/orders/item/${encodeURIComponent(m.slug)}` : `/v1/auctions/search?${queryFor(m)}`, m);
      const offers = offersFrom(data, m);
      const latest = getMonitor(m.id);
      if (!latest || latest.revision !== m.revision || !latest.active) return;
      const chosen = offers.filter(o => allowedStatus(o.status, m.status));
      const five = offers.slice(0, 5);
      latest.result = { time: Date.now(), lowest: chosen[0]?.price ?? null, count: offers.length,
        average: five.length ? Math.round(five.reduce((s, x) => s + x.price, 0) / five.length * 10) / 10 : null,
        error: '', eligible: chosen.filter(o => o.price <= m.threshold).length,
        possiblyLimited: m.kind !== 'item' && data.payload.auctions.length >= 499 };
      putMonitor(latest);
      await notifyOffers(latest, offers);
      const done = getMonitor(m.id);
      if (done?.revision === m.revision) { done.failures = 0; done.nextAt = Date.now() + INTERVAL; putMonitor(done); }
    } catch (e) {
      const latest = getMonitor(m.id);
      if (!latest || latest.revision !== m.revision) return;
      latest.failures = (latest.failures || 0) + 1;
      const retry = Math.min(15 * 60000, 30000 * 2 ** Math.min(latest.failures - 1, 5));
      latest.nextAt = Date.now() + Math.max(retry, e.retryMs || 0);
      latest.result = { ...(latest.result || {}), error: e.message, attempt: Date.now() };
      putMonitor(latest);
    }
    renderList();
  }

  async function runLeader() {
    leader = true;
    try {
      while (true) {
        GM_setValue('wfpa_v3_executor', { id: INSTANCE, time: Date.now() });
        const m = activeMonitors().sort((a, b) => (a.nextAt || 0) - (b.nextAt || 0)).find(x => (x.nextAt || 0) <= Date.now());
        if (m) await checkMonitor(m);
        else await sleep(1500);
      }
    } finally { leader = false; }
  }

  function startMonitor() {
    // Web Locks entrega automaticamente a execução a outra aba quando a atual fecha.
    // Abas do mesmo domínio compartilham a trava. Subdomínios diferentes não compartilham.
    if (navigator.locks?.request) navigator.locks.request('wfpa-price-monitor-v3', runLeader).catch(e => setStatus(e.message, true));
    else void runLeader();
  }

  function migrate() {
    if (GM_getValue('wfpa_v3_migrated', false)) return;
    for (const key of GM_listValues().filter(k => k.startsWith('wfpa_item_'))) {
      const old = GM_getValue(key, null), slug = key.slice('wfpa_item_'.length);
      if (!old || Array.isArray(old) || typeof old !== 'object' || typeof old.active !== 'boolean' || num(old.threshold) === null) continue;
      const id = 'legacy_' + slug;
      if (getMonitor(id)) continue;
      putMonitor({ id, revision: uid(), kind: 'item', slug, name: old.itemName || titleOf(slug), active: old.active,
        threshold: num(old.threshold), platform: 'pc', crossplay: false, status: 'ingame', priceMode: 'direct',
        filters: { rank: old.rankMode === 'max' ? num(old.maxRank) : null }, notified: {}, nextAt: 0 });
    }
    GM_setValue('wfpa_v3_migrated', true);
  }

  // Interface isolada por Shadow DOM: o CSS do site não altera o painel.
  function el(tag, text, attrs = {}) {
    const node = document.createElement(tag);
    if (text !== null && text !== undefined) node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }
  const $ = id => root.getElementById(id);
  function field(label, id, options) {
    const wrap = el('label', label);
    const control = el(options ? 'select' : 'input', null, { id });
    if (options) for (const [value, name] of options) control.append(el('option', name, { value }));
    wrap.append(control); return wrap;
  }
  const val = id => $(id)?.value ?? '';
  const any = label => [['', label || 'Qualquer']];
  const namedOptions = rows => rows.map(x => [x.slug, nameOf(x)]).sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
  function setStatus(text, error = false) { statusNode.textContent = text; statusNode.className = error ? 'error' : ''; }
  function button(text, action) { const b = el('button', text, { type: 'button' }); b.addEventListener('click', action); return b; }
  function numberField(label, id, min, max) {
    const w = field(label, id); const input = w.querySelector('input'); input.type = 'number'; input.min = min; input.step = '1';
    if (max !== undefined) input.max = max;
    return w;
  }

  function buildUI() {
    const host = el('div', null, { id: 'wfpa-v3' });
    document.body.append(host); root = host.attachShadow({ mode: 'open' });
    const style = el('style', `
      :host{all:initial;font-family:Arial,sans-serif;color:#eee;font-size:13px}
      *{box-sizing:border-box} button,input,select{font:inherit} button{cursor:pointer}
      #fab{position:fixed;left:20px;bottom:20px;z-index:2147483646;background:#f0a742;color:#19151d;border:0;border-radius:50%;width:50px;height:50px;font-size:23px}
      #panel{position:fixed;left:20px;bottom:80px;width:min(360px,calc(100vw - 40px));max-height:calc(100vh - 110px);overflow:auto;background:#17161f;border:1px solid #57505e;border-radius:10px;padding:16px;z-index:2147483647;box-shadow:0 8px 24px #0009}
      [hidden]{display:none!important} h2{font-size:17px;color:#f0a742;margin:0 0 12px} h3{font-size:14px;margin:15px 0 8px}
      label{display:block;color:#cac7d1;font-size:12px;margin:9px 0} input,select{display:block;width:100%;margin-top:4px;padding:8px;background:#0c0b11;color:#fff;border:1px solid #4b4458;border-radius:5px}
      button{padding:8px 10px;background:#383041;border:1px solid #63576f;border-radius:5px;color:#fff;margin:4px 4px 4px 0} button.primary{background:#f0a742;color:#151219;font-weight:bold} button:disabled{opacity:.5;cursor:wait}
      .row{display:flex;gap:8px}.row>*{flex:1;min-width:0} p{line-height:1.45;margin:8px 0}.muted{color:#b0aaba;font-size:11px}.error{color:#ff8c8c} #status{white-space:pre-wrap;font-size:12px;line-height:1.4}
      article{margin:8px 0;border:1px solid #484052;padding:10px;border-radius:6px} article p{overflow-wrap:anywhere} article button{font-size:11px} a{color:#ffc576} #close{float:right;margin-top:-6px} .active{color:#9ae3a6}
      details{border-top:1px solid #38303f;margin-top:10px;padding-top:10px} summary{cursor:pointer;color:#c8c1cf;font-size:12px;padding:3px 0} details[open]>summary{margin-bottom:8px;color:#ffc576}
      #context-name{font-size:18px;font-weight:600;color:#fff;margin:6px 0 12px} #context-area{text-transform:uppercase;font-size:10px;letter-spacing:1px;color:#b5a8bf} #save{width:100%;margin-top:8px}
      #status:empty{display:none} #follow-page{padding:0;border:0;background:none;color:#b8a6c9;font-size:11px;margin:0 0 8px}
      #settings-toggle{float:right;margin:-6px 6px 0 0;padding:7px 9px;background:none;color:#b0aaba}
      :host{font-family:Roboto,"Segoe UI",Arial,sans-serif;color:#dce7e9;color-scheme:dark}
      #fab{background:#111e23;border:1px solid #37606a;border-radius:14px;width:56px;height:56px;padding:8px;box-shadow:0 5px 22px #0007;transition:border-color .15s,transform .15s}
      #fab:hover{border-color:#45d7d0;transform:translateY(-2px)} #fab img{width:100%;height:100%;object-fit:contain;display:block}
      #panel{width:min(380px,calc(100vw - 40px));background:#101a1e;border:1px solid #34494f;border-radius:12px;padding:18px;box-shadow:0 16px 60px #0009;scrollbar-width:thin;scrollbar-color:#37525a #101a1e}
      #brand-header{display:flex;align-items:center;gap:10px;background:#17252a;border-bottom:1px solid #2d4249;margin:-18px -18px 18px;padding:14px 16px;position:sticky;top:-18px;z-index:2}
      #brand-header img{width:35px;height:35px;object-fit:contain;flex:none} #brand-header h2{color:#ecf4f5;font-size:16px;letter-spacing:.1px;margin:0;line-height:1.25}
      #brand-copy{flex:1} #brand-copy small{font-size:9px;letter-spacing:1.4px;color:#9aabb1;display:block;margin-top:4px}
      #brand-actions{display:flex;align-items:center;gap:3px} #brand-actions button{float:none;margin:0;background:transparent;border:0;padding:6px;width:29px;height:30px;font-size:17px;color:#9eb2ba}
      #brand-actions button:hover{background:#263c43;color:#fff} #context-area{color:#4ac8bd;letter-spacing:1.2px;font-size:9px;font-weight:600;margin-top:2px}
      #context-name{font-size:19px;line-height:1.3;color:#f0f5f6;margin:6px 0 4px;overflow-wrap:anywhere} #follow-page{color:#8babb6;font-size:10px;margin:2px 0 16px}
      label{color:#a6bdc4;font-size:11px;margin:9px 0} input,select{border:1px solid #344950;background:#0b1418;color:#eaf3f5;border-radius:5px;padding:10px;outline:none}
      input:focus,select:focus{border-color:#42b6c8;box-shadow:0 0 0 2px #42b6c820} #threshold{font-size:23px;font-weight:500;font-variant-numeric:tabular-nums;letter-spacing:.3px;height:48px}
      button{border-color:#344950;background:#1b2c32;border-radius:5px;color:#c1d8de} button:hover{background:#263e46}
      button.primary{background:#418ea4;color:#fff;border:1px solid #5aa9be;font-size:12px;letter-spacing:.15px;padding:12px 8px} button.primary:hover{background:#4da0b6}
      button:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid #5de4d5;outline-offset:3px} button:disabled{cursor:default}
      details{border-color:#2b3d43;margin-top:14px;padding-top:12px} summary{color:#9db3bb;font-size:11px} details[open]>summary{color:#d1e1e5}
      #saved-section>summary{font-size:11px;font-weight:600;color:#c9dce1;letter-spacing:.3px} article{border:1px solid #293e46;border-left:2px solid #32b8a8;border-radius:6px;background:#152329;padding:11px 12px;margin-top:10px}
      article a{font-size:12px;font-weight:600;text-decoration:none;color:#63b7ca} article a:hover{text-decoration:underline} article p{margin:6px 0}
      article details{border:0;margin-top:5px;padding-top:2px} article summary{font-size:10px;color:#819da8} article button{font-size:10px;padding:6px 8px} .active{color:#62c8b0;font-size:11px}
      article:has(.paused){border-left-color:#53636b} .paused{color:#98aab0;font-size:11px}.muted{color:#91a8b1;font-size:10px} .error{color:#ff9595}
      #status{font-size:11px;color:#8ed8cd} #status.error{color:#ff9595} #settings{padding:12px;background:#142329;border:1px solid #30444c;border-radius:6px}
      @media(prefers-reduced-motion:reduce){#fab{transition:none}#fab:hover{transform:none}}
    `);
    root.append(style);
    const panel = el('section', null, { id: 'panel', hidden: '', 'aria-label': 'Warframe Monitor' });
    const fab = button('', () => { panel.hidden = !panel.hidden; fab.setAttribute('aria-expanded', String(!panel.hidden)); renderList(true); }); fab.id = 'fab'; fab.title = 'Warframe Monitor';
    fab.setAttribute('aria-label', 'Abrir Warframe Monitor'); fab.setAttribute('aria-expanded', 'false');
    fab.append(el('img', null, { src: BRAND_ICON, alt: '', draggable: 'false' }));
    const close = button('×', () => { panel.hidden = true; fab.setAttribute('aria-expanded', 'false'); }); close.id = 'close'; close.setAttribute('aria-label', 'Fechar');
    panel.append(close, el('h2', 'Warframe Monitor'), el('p', 'Itens, Rivens, Liches e Sisters', { class: 'muted' }));
    panel.append(field('Webhook do Discord', 'webhook')); root.append(fab, panel);
    $('webhook').type = 'password'; $('webhook').autocomplete = 'off'; $('webhook').value = GM_getValue(WEBHOOK, '');
    panel.append(button('Salvar webhook', () => {
      const w = val('webhook').trim(); if (!validWebhook(w)) return setStatus('Cole a URL completa de um webhook oficial do Discord.', true);
      GM_setValue(WEBHOOK, w); if ($('settings')) $('settings').hidden = true; setStatus('Webhook salvo.');
    }), button('Testar webhook', async () => {
      const w = val('webhook').trim(); if (!validWebhook(w)) return setStatus('Webhook inválido.', true);
      try { await http(w, { method: 'POST', body: { content: '✅ Warframe Monitor: teste recebido.', allowed_mentions: { parse: [] } } }); setStatus('Teste enviado. Use “Salvar webhook” para guardar esta URL.'); }
      catch (e) { setStatus(e.message, true); }
    }));
    panel.append(el('h3', 'Configurar monitor'), button('Usar página / busca atual', () => importPage().catch(e => setStatus(e.message, true))), button('Novo monitor', () => loadForm(null)));
    // Estado interno da página; não há buscador de itens dentro do notificador.
    const kindState = field('Categoria', 'kind', Object.entries(KINDS)); kindState.hidden = true;
    const weaponState = field('Item detectado', 'weapon'); weaponState.hidden = true;
    weaponState.querySelector('input').type = 'hidden';
    panel.append(kindState, weaponState);
    panel.append(el('div', null, { id: 'filters' }));
    panel.append(numberField('Seu preço máximo (plat)', 'threshold', 0));
    panel.append(field('Status do vendedor', 'seller-status', [['ingame', 'Somente IN-GAME'], ['online', 'No jogo ou online no site'], ['all', 'Qualquer status, inclusive offline']]));
    panel.append(field('Preço dos contratos', 'price-mode', [['direct', 'Somente venda direta'], ['buyout', 'Venda direta + compra imediata de leilão']]));
    const save = button('Salvar e ativar monitor', () => saveForm().catch(e => setStatus(e.message, true))); save.id = 'save'; save.className = 'primary'; panel.append(save);
    $('threshold').addEventListener('input', updatePriceButton);
    updatePriceButton();
    statusNode = el('p', '', { id: 'status', role: 'status' }); panel.append(statusNode);
    panel.append(el('p', 'Consultas a cada 2 minutos por monitor, mais o tempo da fila. Mantenha o navegador aberto e uma aba do Market ativa. Use um único domínio do Market para evitar executores em subdomínios diferentes.', { class: 'muted' }));
    panel.append(el('h3', 'Monitores salvos'), el('p', '', { id: 'executor', class: 'muted' }));
    listNode = el('div'); panel.append(listNode);
    compactUI();
    void syncPage(true);
    setInterval(() => renderList(), 2000);
    setInterval(() => { void syncPage(); }, 750);
    window.addEventListener('popstate', () => { void syncPage(); });
  }

  function disclosure(label, id) {
    const d = el('details', null, { id }); d.append(el('summary', label)); return d;
  }

  function compactUI() {
    const panel = $('panel');
    // Reutiliza os controles e seus eventos, mas deixa o fluxo principal curto.
    const buttons = [...panel.children].filter(n => n.tagName === 'BUTTON');
    const settings = disclosure('Configurações', 'settings');
    settings.append($('webhook').parentElement);
    for (const b of buttons.filter(n => ['Salvar webhook', 'Testar webhook'].includes(n.textContent))) settings.append(b);
    for (const id of ['seller-status', 'price-mode']) settings.append($(id).parentElement);
    buildTestMenu(settings);
    settings.append($('executor'));
    settings.append(el('p', 'Mantenha uma aba do Market aberta. Consultas a cada 2 min, mais o tempo da fila. Use um único domínio do site.', { class: 'muted' }));
    settings.open = true;
    settings.hidden = validWebhook(GM_getValue(WEBHOOK, ''));
    const gear = button('⚙', () => { settings.hidden = !settings.hidden; settings.open = true; if (!settings.hidden) settings.scrollIntoView({ block: 'nearest' }); });
    gear.id = 'settings-toggle'; gear.title = 'Configurações'; gear.setAttribute('aria-label', 'Configurações');
    panel.insertBefore(gear, panel.querySelector('h2'));
    const filters = disclosure('Filtros', 'filter-section'); filters.append($('filters'));
    const saved = disclosure('Monitores salvos', 'saved-section'); saved.open = true; saved.append(listNode);
    const context = el('div', null, { id: 'page-context' });
    context.append(el('p', '', { id: 'context-area' }), el('p', '', { id: 'context-name' }));
    const follow = button('Usar página atual', () => { void syncPage(true); }); follow.id = 'follow-page';
    for (const b of buttons.filter(n => ['Usar página / busca atual', 'Novo monitor'].includes(n.textContent))) b.remove();
    for (const n of [...panel.children]) if (n.tagName === 'H3' || (n.tagName === 'P' && n !== statusNode)) n.remove();
    panel.append(context, follow, $('kind').parentElement, $('weapon').parentElement, $('threshold').parentElement, $('save'), statusNode, filters, saved, settings);
    const header = el('header', null, { id: 'brand-header' });
    const copy = el('div', null, { id: 'brand-copy' }); copy.append(panel.querySelector('h2'), el('small', 'ALPHA · ALERTAS DE MERCADO'));
    const actions = el('div', null, { id: 'brand-actions' }); actions.append(gear, $('close'));
    header.append(el('img', null, { src: BRAND_ICON, alt: '', draggable: 'false' }), copy, actions);
    panel.prepend(header);
  }

  function pageContext(href = location.href) {
    const u = new URL(href), contracts = /^\/(?:[a-z]{2}(?:-[a-z]+)?\/)?(?:auctions|auction)(?:\/|$)/i.test(u.pathname);
    const selected = contracts ? document.querySelector('#auctions-search-type')?.value : null;
    const market = siteMarket(href);
    let model = null, error = '';
    try { model = parsePage(href); } catch (e) { if (/\/auctions\/search/.test(u.pathname)) error = e.message; }
    // O seletor do site pode mudar antes de Search atualizar a URL.
    if (contracts && ['riven', 'lich', 'sister'].includes(selected) && model?.kind !== selected) { model = null; error = ''; }
    const kind = contracts ? (['riven', 'lich', 'sister'].includes(selected) ? selected : model?.kind || 'riven') : 'item';
    if (model) Object.assign(model, market);
    return { key: href + '|' + (selected || ''), contracts, kind, model, error, ...market, fixedKind: !contracts || !!selected || !!model };
  }

  async function syncPage(force = false) {
    if (!root) return;
    const ctx = pageContext();
    if (!force && ctx.key === pageKey) return;
    pageKey = ctx.key;
    const generation = ++contextGeneration;
    const choices = ctx.contracts ? Object.entries(KINDS).filter(([k]) => k !== 'item') : [['item', KINDS.item]];
    $('kind').replaceChildren(...choices.map(([k, label]) => el('option', label, { value: k })));
    let m = ctx.model || { kind: ctx.kind, platform: ctx.platform, crossplay: ctx.crossplay, filters: {} };
    // Ao voltar a um item, oferece a edição do monitor já salvo quando não há ambiguidade.
    const existing = ctx.model?.kind === 'item' ? monitors().filter(x => x.kind === 'item' && x.slug === m.slug && x.platform === m.platform) : [];
    if (existing.length === 1) m = existing[0];
    $('kind').parentElement.hidden = true;
    $('weapon').parentElement.hidden = true;
    $('filter-section').open = false;
    await loadForm(m);
    if (generation !== contextGeneration) return;
    $('context-area').textContent = ctx.contracts ? 'Contratos · ' + KINDS[ctx.kind] : 'Mercado · Itens';
    $('context-name').textContent = m.slug ? (m.name || titleOf(m.slug)) : (ctx.contracts ? 'Abra uma busca de contrato' : 'Abra a página de um item');
    // loadForm pode obter o nome localizado a partir do catálogo.
    const item = formCatalog.find(x => x.slug === m.slug);
    if (item) $('context-name').textContent = nameOf(item);
    if (ctx.error) setStatus(ctx.error, true);
    else if (!m.slug) setStatus(ctx.contracts ? 'Escolha a arma no site e clique em Search. O painel reconhecerá a busca automaticamente.' : 'Entre na página do item no Market. Aqui você só precisa definir o preço.');
  }

  async function setupFilters(values = {}, weapon = '') {
    const generation = ++formGeneration, kind = val('kind');
    $('save').disabled = true; $('filters').replaceChildren(); formCatalog = [];
    $('weapon').value = weapon;
    $('threshold').parentElement.hidden = !weapon;
    $('save').hidden = !weapon;
    $('filter-section').hidden = !weapon;
    $('price-mode').parentElement.hidden = kind === 'item';
    if (!weapon) { setStatus(''); return; }
    setStatus('Carregando catálogo e filtros…');
    try {
      const weapons = await catalog(kind === 'item' ? 'items' : `${kind}/weapons`);
      if (generation !== formGeneration) return;
      formCatalog = weapons;
      if (!weapons.some(item => item.slug === weapon)) throw new Error('O item da página não foi encontrado no catálogo.');
      $('weapon').value = weapon;
      if (kind === 'item') {
        $('filters').append(field('Rank', 'rank-mode', [['any', 'Qualquer rank'], ['max', 'Somente rank máximo']]));
        const ranked = num(weapons.find(item => item.slug === weapon)?.maxRank) !== null;
        $('rank-mode').parentElement.hidden = !ranked;
        $('filter-section').hidden = !ranked;
      }
      else if (kind === 'riven') {
        const attrs = await catalog('riven/attributes');
        if (generation !== formGeneration) return;
        for (let n = 1; n <= 3; n++) $('filters').append(field(`Atributo positivo ${n}`, 'positive' + n, [...any('Sem exigência'), ...namedOptions(attrs.filter(x => !x.negativeOnly))]));
        $('filters').append(field('Atributo negativo', 'negative', [...any('Sem preferência'), ['has', 'Precisa ter negativo'], ['none', 'Sem atributo negativo'], ...namedOptions(attrs.filter(x => !x.positiveOnly))]));
        $('filters').append(field('Polaridade', 'polarity', [...any(), ['madurai', 'Madurai'], ['vazarin', 'Vazarin'], ['naramon', 'Naramon']]));
        $('filters').append(field('Rank do Riven', 'maxed', [['false', 'Qualquer rank'], ['true', 'Somente máximo (8)']]));
        for (const [label, prefix, min, max] of [['MR exigido', 'mastery_rank', 8, 16], ['Rolagens', 're_rolls', 0, undefined]]) {
          const row = el('div', null, { class: 'row' });
          row.append(numberField(label + ' mínimo', prefix + '_min', min, max), numberField(label + ' máximo', prefix + '_max', min, max)); $('filters').append(row);
        }
      } else {
        $('filters').append(field('Elemento', 'element', [...any(), ...Object.entries(ELEMENTS)]));
        $('filters').append(field('Efêmera', 'ephemera', [...any(), ['true', 'Com efêmera'], ['false', 'Sem efêmera']]));
        $('filters').append(el('p', 'Para uma efêmera específica, selecione “Com efêmera” e o elemento correspondente.', { class: 'muted' }));
        const row = el('div', null, { class: 'row' }); row.append(numberField('Bônus mínimo (%)', 'damage_min', 25, 60), numberField('Bônus máximo (%)', 'damage_max', 25, 60)); $('filters').append(row);
        const quirks = await catalog(`${kind}/quirks`);
        if (generation !== formGeneration) return;
        $('filters').append(field('Peculiaridade (quirk)', 'quirk', [...any(), ...namedOptions(quirks)]));
      }
      if (generation !== formGeneration) return;
      for (const [key, value] of Object.entries(values)) if ($(key)) $(key).value = value ?? '';
      if (kind === 'riven') (values.positive || []).forEach((p, i) => { if ($('positive' + (i + 1))) $('positive' + (i + 1)).value = p; });
      if (kind === 'item' && values.rank !== null && values.rank !== undefined) $('rank-mode').value = 'max';
      setStatus(''); $('save').disabled = false;
    } catch (e) {
      if (generation === formGeneration) setStatus(`Não foi possível carregar o catálogo: ${e.message} Use “Usar página atual” para tentar novamente.`, true);
    }
  }

  async function loadForm(m) {
    editing = m?.id || null;
    if (![...$('kind').options].some(o => o.value === (m?.kind || 'item'))) $('kind').append(el('option', KINDS[m?.kind || 'item'], { value: m?.kind || 'item' }));
    $('kind').value = m?.kind || 'item'; $('threshold').value = m?.threshold ?? '';
    updatePriceButton();
    $('seller-status').value = m?.status || 'ingame';
    $('price-mode').value = m?.priceMode || 'direct';
    const generation = formGeneration + 1;
    await setupFilters(m?.filters || {}, m?.slug || '');
    if (generation !== formGeneration) return;
    if ($('filter-section')) $('filter-section').querySelector('summary').textContent = 'Filtros · ' + KINDS[val('kind')];
    if (m?.id && $('context-name')) {
      $('context-area').textContent = 'Editando · ' + KINDS[m.kind];
      $('context-name').textContent = m.name || titleOf(m.slug);
      $('weapon').parentElement.hidden = true;
    }
  }

  function readRange(filters, prefix, min, max = Infinity) {
    for (const suffix of ['min', 'max']) {
      const key = prefix + '_' + suffix, raw = val(key), n = num(raw);
      if (raw !== '' && (n === null || !Number.isInteger(n) || n < min || n > max)) throw new Error(`Valor inválido em ${$(key).parentElement.firstChild.textContent}.`);
      filters[key] = n;
    }
    if (filters[prefix + '_min'] !== null && filters[prefix + '_max'] !== null && filters[prefix + '_min'] > filters[prefix + '_max']) throw new Error('O mínimo não pode ser maior que o máximo.');
  }

  function updatePriceButton() {
    const price = num(val('threshold'));
    $('save').textContent = price !== null && price >= 0 && Number.isInteger(price)
      ? `Alertar por ${price} plat ou menos`
      : 'Defina o preço para ativar';
  }

  async function saveForm() {
    if ($('save').disabled) return;
    const generation = formGeneration, kind = val('kind'), raw = val('weapon').trim();
    const list = await catalog(kind === 'item' ? 'items' : `${kind}/weapons`);
    if (generation !== formGeneration) return;
    const weapon = list.find(x => x.slug === raw || nameOf(x).toLowerCase() === raw.toLowerCase());
    if (!weapon) throw new Error('Abra a página do item ou aplique uma busca de contrato no site.');
    const threshold = num(val('threshold'));
    if (threshold === null || threshold < 0 || !Number.isInteger(threshold)) throw new Error('Informe um preço inteiro de zero ou mais platinas.');
    const webhook = val('webhook').trim();
    if (!validWebhook(webhook)) { if ($('settings')) { $('settings').hidden = false; $('settings').open = true; } throw new Error('Preencha o webhook do Discord antes de ativar.'); }
    const filters = {};
    if (kind === 'item') {
      filters.rank = val('rank-mode') === 'max' ? num(weapon.maxRank) : null;
      if (val('rank-mode') === 'max' && filters.rank === null) throw new Error('Este item não possui rank. Selecione “Qualquer rank”.');
    } else if (kind === 'riven') {
      filters.positive = [val('positive1'), val('positive2'), val('positive3')].filter(Boolean);
      if (new Set(filters.positive).size !== filters.positive.length) throw new Error('Não repita o mesmo atributo positivo.');
      filters.positive.sort(); filters.negative = val('negative'); filters.polarity = val('polarity'); filters.maxed = val('maxed') === 'true';
      if (filters.positive.includes(filters.negative)) throw new Error('O mesmo atributo não pode ser positivo e negativo.');
      const attrs = await catalog('riven/attributes');
      if (generation !== formGeneration) return;
      for (const slug of [...filters.positive, filters.negative].filter(x => x && !['has', 'none'].includes(x))) {
        const a = attrs.find(x => x.slug === slug);
        if (!a || (a.exclusiveTo?.length && !a.exclusiveTo.includes(weapon.rivenType))) throw new Error(`O atributo ${titleOf(slug)} não é compatível com esta arma.`);
      }
      readRange(filters, 'mastery_rank', 8, 16); readRange(filters, 're_rolls', 0);
    } else {
      filters.element = val('element'); filters.ephemera = val('ephemera'); filters.quirk = val('quirk'); readRange(filters, 'damage', 25, 60);
    }
    const old = editing ? getMonitor(editing) : null;
    const market = siteMarket();
    const m = { id: old?.id || uid(), revision: uid(), kind, slug: weapon.slug, name: nameOf(weapon), filters, threshold,
      ...market, status: val('seller-status'), priceMode: val('price-mode'),
      active: true, nextAt: 0, failures: 0, notified: old?.notified || {} };
    if (old && identity(old) !== identity(m)) m.notified = {};
    const duplicate = !old && monitors().find(x => identity(x) === identity(m));
    if (duplicate) { m.id = duplicate.id; m.notified = duplicate.notified || {}; }
    GM_setValue(WEBHOOK, webhook); putMonitor(m); editing = m.id;
    if ($('settings')) $('settings').hidden = true;
    setStatus('Monitor salvo e colocado na fila. Ofertas novas dentro do limite serão enviadas ao Discord.'); renderList(true);
  }

  function parsePage(href) {
    const u = new URL(href);
    const platform = ['ps4', 'xbox', 'switch', 'mobile'].find(p => u.hostname === p + '.warframe.market') || 'pc';
    const item = /^\/(?:[a-z]{2}(?:-[a-z]+)?\/)?items\/([^/]+)(?:\/|$)/i.exec(u.pathname);
    if (item) {
      // Decode exatamente uma vez: Rivens velados usam parênteses, que podem
      // chegar como caracteres literais ou como %28 e %29 na URL.
      const slug = decodeURIComponent(item[1]);
      if (!slug || /[\/\\\s\x00-\x1f]/.test(slug)) throw new Error('Endereço de item inválido.');
      return { kind: 'item', slug, filters: {}, platform };
    }
    if (!/^\/(?:[a-z]{2}(?:-[a-z]+)?\/)?auctions\/search\/?$/i.test(u.pathname)) throw new Error('Abra uma página de item ou faça uma busca em Contratos e clique em “Search”.');
    const q = u.searchParams, kind = q.get('type'), slug = q.get('weapon_url_name');
    if (!['riven', 'lich', 'sister'].includes(kind) || !slug) throw new Error('Faça uma busca com uma arma específica antes de importar.');
    const allowed = new Set(['type', 'weapon_url_name', 'sort_by', 'buyout_policy', 'positive_stats', 'negative_stats', 'polarity', 'mod_rank', 'mastery_rank_min', 'mastery_rank_max', 're_rolls_min', 're_rolls_max', 'element', 'has_ephemera', 'damage_min', 'damage_max', 'quirk']);
    const unknown = [...q.keys()].filter(k => !allowed.has(k));
    if (unknown.length) throw new Error(`A busca contém filtros não reconhecidos: ${unknown.join(', ')}. Remova esses filtros no site e aplique a busca novamente.`);
    if (q.get('buyout_policy') === 'auction') throw new Error('Essa busca é só de leilões. Configure no painel “Venda direta + compra imediata de leilão” para alertas de preço de compra.');
    const filters = {};
    if (kind === 'riven') {
      filters.positive = (q.get('positive_stats') || '').split(',').filter(Boolean);
      if (filters.positive.length > 3) throw new Error('A busca contém mais de três atributos positivos.');
      filters.negative = q.get('negative_stats') || ''; filters.polarity = q.get('polarity') === 'any' ? '' : q.get('polarity') || '';
      filters.maxed = q.get('mod_rank') === 'maxed';
      for (const key of ['mastery_rank_min', 'mastery_rank_max', 're_rolls_min', 're_rolls_max']) filters[key] = num(q.get(key));
    } else {
      filters.element = q.get('element') === 'any' ? '' : q.get('element') || ''; filters.ephemera = q.get('has_ephemera') || ''; filters.quirk = q.get('quirk') || '';
      filters.damage_min = num(q.get('damage_min')); filters.damage_max = num(q.get('damage_max'));
    }
    return { kind, slug, filters, platform, priceMode: q.get('buyout_policy') === 'direct' ? 'direct' : 'buyout' };
  }

  async function importPage() {
    const m = parsePage(location.href); await loadForm(m);
    if ($('save').disabled) return;
    setStatus('Busca carregada. Informe o limite e salve. Plataforma e crossplay seguem a seleção do site ao salvar.');
  }

  function filterSummary(m) {
    const f = m.filters || {}, parts = [];
    if (m.kind === 'item' && f.rank !== null && f.rank !== undefined) parts.push('rank ' + f.rank);
    if (m.kind === 'riven') {
      if (f.positive?.length) parts.push('+: ' + f.positive.map(titleOf).join(', '));
      if (f.negative) parts.push('−: ' + ({ has: 'obrigatório', none: 'sem negativo' }[f.negative] || titleOf(f.negative)));
      if (f.polarity) parts.push(f.polarity); if (f.maxed) parts.push('rank 8');
      for (const [key, label] of [['mastery_rank', 'MR'], ['re_rolls', 'rolagens']]) if (num(f[key + '_min']) !== null || num(f[key + '_max']) !== null) parts.push(`${label}: ${f[key + '_min'] ?? 'qualquer'}–${f[key + '_max'] ?? 'qualquer'}`);
    } else if (m.kind !== 'item') {
      if (f.element) parts.push(ELEMENTS[f.element]);
      if (f.ephemera) parts.push(f.ephemera === 'true' ? 'com efêmera' : 'sem efêmera');
      if (num(f.damage_min) !== null || num(f.damage_max) !== null) parts.push(`bônus ${f.damage_min ?? 25}–${f.damage_max ?? 60}%`);
      if (f.quirk) parts.push(titleOf(f.quirk));
    }
    return parts.join(' · ') || 'Sem filtros adicionais';
  }

  function renderList(force = false) {
    if (!listNode) return;
    const all = monitors();
    const signature = JSON.stringify(all) + leader;
    if (!force && signature === uiSignature) return;
    uiSignature = signature;
    $('executor').textContent = leader ? 'Esta aba executa as consultas.' : 'Consultas executadas pela outra aba deste domínio; esta assumirá se ela fechar.';
    const opened = new Set([...listNode.querySelectorAll('details[open]')].map(d => d.dataset.monitor));
    listNode.replaceChildren();
    if ($('saved-section')) $('saved-section').querySelector('summary').textContent = `Monitores salvos (${all.length})`;
    if (!all.length) { listNode.append(el('p', 'Nenhum monitor salvo.', { class: 'muted' })); return; }
    for (const m of all) {
      const card = el('article'); const link = el('a', `${KINDS[m.kind]} · ${m.name}`, { href: searchUrl(m), target: '_blank', rel: 'noopener noreferrer' }); card.append(link);
      card.append(el('p', `${m.active ? 'Ativo' : 'Pausado'} · até ${m.threshold} plat`, { class: m.active ? 'active' : 'paused' }));
      const details = el('details', null, { 'data-monitor': m.id }); details.open = opened.has(m.id);
      details.append(el('summary', m.result?.error ? 'Detalhes · erro na consulta' : 'Detalhes e ações'));
      details.append(el('p', filterSummary(m), { class: 'muted' }));
      details.append(el('p', `${m.platform}${m.crossplay ? ' + crossplay' : ''} · ${m.status}`, { class: 'muted' }));
      if (m.result) {
        const r = m.result;
        if (r.time) details.append(el('p', `Última consulta: ${new Date(r.time).toLocaleTimeString('pt-BR')} · menor no status escolhido: ${r.lowest ?? '—'} plat · média das até 5 menores retornadas: ${r.average ?? '—'} plat (${r.count} ofertas retornadas).`, { class: 'muted' }));
        if (r.possiblyLimited) details.append(el('p', 'Busca possivelmente limitada pela API. Use filtros mais específicos para melhorar a cobertura.', { class: 'muted' }));
        if (r.error) details.append(el('p', `${r.error} Nova tentativa: ${new Date(m.nextAt).toLocaleTimeString('pt-BR')}`, { class: 'error' }));
      } else details.append(el('p', 'Aguardando consulta na fila.', { class: 'muted' }));
      details.append(button('Editar', () => { $('panel').scrollTop = 0; $('kind').parentElement.hidden = true; return loadForm(getMonitor(m.id)); }), button(m.active ? 'Pausar' : 'Ativar', () => {
        const latest = getMonitor(m.id); if (!latest) return;
        latest.active = !latest.active; latest.revision = uid(); latest.nextAt = 0; putMonitor(latest); renderList(true);
      }), button('Consultar agora', () => { const latest = getMonitor(m.id); if (latest) { if (!latest.active) return setStatus('Ative este monitor antes de consultar.', true); latest.nextAt = 0; putMonitor(latest); setStatus('Consulta colocada na fila; os limites de frequência continuam valendo.'); } }),
      button('Remover', () => { GM_deleteValue(PREFIX + m.id); if (editing === m.id) editing = null; renderList(true); }));
      card.append(details); listNode.append(card);
    }
  }

  function init() {
    if (document.getElementById('wfpa-v3')) return;
    migrate(); buildUI(); startMonitor();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
