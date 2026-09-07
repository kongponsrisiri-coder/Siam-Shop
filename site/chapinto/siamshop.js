/* Cha & Pinto Box — live data for the marketing site.
 *
 * Sandy's design is untouched: this file only replaces the hard-coded sample
 * content with what is actually in SiamShop, reusing her existing classes
 * (.prods/.prod/.ph/.body/.pr, .cats a[data-cat], .menu-list) so the CSS and
 * the look stay exactly as designed.
 *
 * Drop-in: <script defer src="siamshop.js"></script> after app.js. Nothing else
 * on the page needs to change — every hook below is optional and the script
 * leaves the static markup alone if an element or the API is missing, so the
 * page never ends up worse than the mockup.
 *
 * Configure with <body data-shop="demo" data-api="https://…"> or edit CFG.
 */
(function () {
  'use strict';
  var body = document.body;
  var CFG = {
    api: (body.dataset.api || 'https://siam-shop-production.up.railway.app').replace(/\/$/, ''),
    shop: body.dataset.shop || 'demo',
    // Products shown in the "Thai market" teaser grid (the rest live in the shop).
    marketLimit: Number(body.dataset.marketLimit || 24),
  };
  var shopUrl = function (path) { return CFG.api + '/shop' + (path || '') + (path && path.indexOf('?') >= 0 ? '&' : '?') + 'shop=' + encodeURIComponent(CFG.shop); };
  var money = function (n) { return '£' + Number(n || 0).toFixed(2); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  // The catalogue is shouted in caps; the design wants sentence case.
  var titleCase = function (s) {
    return String(s || '').toLowerCase().replace(/\b([a-z])/g, function (m, c) { return c.toUpperCase(); })
      .replace(/\b(\d+)(g|kg|ml|l|cm)\b/gi, function (m, n, u) { return n + u.toLowerCase(); })
      .replace(/\bAnd\b/g, 'and').replace(/\bWith\b/g, 'with').replace(/\bOf\b/g, 'of');
  };
  var get = function (path) {
    return fetch(CFG.api + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'shop=' + encodeURIComponent(CFG.shop), { headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  };
  var imgFor = function (p) {
    if (!p.image_url) return '';
    return /^https?:/.test(p.image_url) ? p.image_url : CFG.api + p.image_url;
  };

  /* ---- Thai market grid: real products, real photos, category chips ------- */
  function renderMarket(products, categories) {
    var grid = document.querySelector('.prods');
    if (!grid || !products.length) return;
    var retail = products.filter(function (p) { return p.kind !== 'food' && p.is_active !== false; });
    if (!retail.length) return;

    // Chips: the categories that actually have stock on the shelf, biggest first.
    var counts = {};
    retail.forEach(function (p) { if (p.category) counts[p.category] = (counts[p.category] || 0) + 1; });
    var cats = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 6);

    var shown = retail.slice(0, CFG.marketLimit);
    grid.innerHTML = shown.map(function (p) {
      var src = imgFor(p);
      return '<div class="prod" data-cat="' + esc((p.category || 'other').toLowerCase().replace(/[^a-z0-9]+/g, '-')) + '">'
        + '<div class="ph">' + (src ? '<img src="' + esc(src) + '" alt="' + esc(titleCase(p.name)) + '" loading="lazy">' : '') + '</div>'
        + '<div class="body"><h3>' + esc(titleCase(p.name)) + '</h3><div class="pr">' + money(p.price) + '</div></div>'
        + '</div>';
    }).join('');

    if (cats.length > 1 && !document.querySelector('.cats')) {
      var bar = document.createElement('div');
      bar.className = 'cats center';
      bar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin:0 0 22px';
      bar.innerHTML = ['all'].concat(cats).map(function (c, i) {
        var key = c === 'all' ? 'all' : c.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        return '<a href="#" data-cat="' + esc(key) + '" class="chip' + (i === 0 ? ' on' : '') + '">' + esc(c === 'all' ? 'All' : c) + '</a>';
      }).join('');
      grid.parentNode.insertBefore(bar, grid);
      // Her app.js bound its filter before these existed, so bind ours here.
      bar.addEventListener('click', function (e) {
        var a = e.target.closest('a[data-cat]');
        if (!a) return;
        e.preventDefault();
        bar.querySelectorAll('a').forEach(function (x) { x.classList.remove('on'); });
        a.classList.add('on');
        var want = a.dataset.cat;
        grid.querySelectorAll('.prod').forEach(function (p) {
          p.style.display = want === 'all' || p.dataset.cat === want ? '' : 'none';
        });
      });
    }

    // "299 products online" → whatever is really on the shelf today.
    document.querySelectorAll('.kicker').forEach(function (k) {
      if (/\d+\s*products/i.test(k.textContent)) k.textContent = k.textContent.replace(/\d+\s*products/i, retail.length + ' products');
    });
  }

  /* ---- Lunch + boba: prices and item names from the real menu ------------- */
  function renderMenus(products) {
    var food = products.filter(function (p) { return p.kind === 'food' && p.is_active !== false; });
    if (!food.length) return;
    var pick = function (re) { return food.filter(function (p) { return re.test(p.category || ''); }); };
    // Boxes and nibbles share the lunch menu block, but only the BOXES set the
    // "from" price in the copy — otherwise a £4.50 side rewrites it nonsensically.
    var boxes = pick(/lunch/i), lunch = pick(/lunch|nibble/i), boba = pick(/boba|dessert/i);

    // Any element the design marks for a live menu gets one; otherwise we only
    // correct the "from £x" figures already written into the copy.
    var slots = document.querySelectorAll('[data-menu]');
    if (slots.length) {
      slots.forEach(function (el) {
        var list = el.dataset.menu === 'boba' ? boba : lunch;
        if (!list.length) return;
        el.innerHTML = '<ul class="menu-list" style="list-style:none;padding:0;margin:0">' + list.map(function (p) {
          var opts = (p.option_groups || []).filter(function (g) { return (g.options || []).some(function (o) { return Number(o.price_delta) > 0; }); });
          var extra = opts.length ? ' <span class="muted" style="opacity:.65;font-size:.85em">+ ' + esc(opts.map(function (g) { return g.name.toLowerCase(); }).join(', ')) + '</span>' : '';
          return '<li style="display:flex;justify-content:space-between;gap:16px;padding:9px 0;border-bottom:1px solid var(--line,#eee)">'
            + '<span>' + esc(p.name) + extra + '</span><span class="pr">' + money(p.price) + '</span></li>';
        }).join('') + '</ul>';
      });
    }
    // Keep the written prices honest, but only ever replace a price with one of
    // the same kind: cheapest box for the lunch line, cheapest drink for the café.
    var cheapest = function (list) { return list.length ? Math.min.apply(null, list.map(function (p) { return Number(p.price); })) : null; };
    // "Large" is a Size option on the same product, not a second product, so the
    // top price is base + the dearest size choice.
    var sizeUplift = function (p) {
      var g = (p.option_groups || []).filter(function (x) { return /size/i.test(x.name || ''); })[0];
      if (!g || !g.options || !g.options.length) return 0;
      return Math.max.apply(null, g.options.map(function (o) { return Number(o.price_delta) || 0; }));
    };
    var topPrice = function (list) { return list.length ? Math.max.apply(null, list.map(function (p) { return Number(p.price) + sizeUplift(p); })) : null; };
    var boxLo = cheapest(boxes), boxHi = topPrice(boxes), bobaLo = cheapest(boba);
    document.querySelectorAll('.lede, .p, p').forEach(function (el) {
      var t = el.textContent;
      if (!/£/.test(t)) return;
      if (boxLo && /Medium\s*£[\d.]+/i.test(t)) el.textContent = t = t.replace(/(Medium\s*)£[\d.]+/i, '$1' + money(boxLo));
      if (boxHi && /large\s*£[\d.]+/i.test(t)) el.textContent = t = t.replace(/(large\s*)£[\d.]+/i, '$1' + money(boxHi));
      if (bobaLo && /£5\.25/.test(t)) el.textContent = t.replace(/£5\.25/, money(bobaLo));
    });
  }

  /* ---- Order buttons point at the real shop ------------------------------- */
  function wireOrderLinks() {
    document.querySelectorAll('a[href]').forEach(function (a) {
      var href = a.getAttribute('href') || '';
      var label = (a.textContent || '').toLowerCase();
      if (/baan-siam\.siamepos\.co\.uk/.test(href) || /order for collection|pre-?order/.test(label)) {
        a.setAttribute('href', shopUrl(''));
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener');
      } else if (href === '/shop' || /browse the market/.test(label)) {
        a.setAttribute('href', shopUrl(''));
      } else if (href === '/lunch' || href === '/boba') {
        a.setAttribute('href', shopUrl(''));
      }
    });
    // The mockup disclaimer is no longer true once this is live.
    document.querySelectorAll('.note, .disclaimer, footer p').forEach(function (el) {
      if (/sample menu|mockup|not live/i.test(el.textContent)) el.style.display = 'none';
    });
  }

  get('/api/products').then(function (data) {
    var products = Array.isArray(data) ? data : data.products || [];
    if (!products.length) return;
    renderMarket(products);
    renderMenus(products);
    wireOrderLinks();
    body.classList.add('siamshop-live');
  }).catch(function (e) {
    // Offline or API down: Sandy's static content stays exactly as it is.
    if (window.console) console.warn('[siamshop] live data unavailable, keeping static content:', e.message);
  });
})();
