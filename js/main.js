// SILLAGE — scripts du site
// 1. Navigation (double couche + menu mobile)
// 2. Traversée : bateau, sillage, flou d'eau
// 3. Compteurs des résultats

(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- 1. Navigation ----------
  // La barre est dupliquée en version claire ; le sillage découpe cette copie,
  // si bien que le menu change de couleur exactement le long de l'écume.
  var header = document.getElementById('header');
  var headerLight = header.querySelector('.header__layer').cloneNode(true);
  headerLight.classList.add('header__layer--light');
  headerLight.setAttribute('aria-hidden', 'true');
  headerLight.querySelectorAll('a, button').forEach(function (el) { el.tabIndex = -1; });
  header.appendChild(headerLight);

  function setMenu(open) {
    document.body.classList.toggle('menu-open', open);
    header.querySelectorAll('.burger').forEach(function (b) {
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
      b.setAttribute('aria-label', open ? 'Fermer le menu' : 'Ouvrir le menu');
    });
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest('.burger')) {
      setMenu(!document.body.classList.contains('menu-open'));
    } else if (e.target.closest('.menu a')) {
      setMenu(false);
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setMenu(false); });
  window.matchMedia('(min-width: 861px)').addEventListener('change', function (e) { if (e.matches) setMenu(false); });

  // ---------- 2. Traversée ----------
  var voyage = document.querySelector('.voyage');
  var stage = voyage.querySelector('.voyage__stage');
  var rim = stage.querySelector('.wake__rim');
  var water = stage.querySelector('.wake__water');
  var content = stage.querySelector('.wake__content');
  var canvas = stage.querySelector('.wake__lines');
  var boat = stage.querySelector('.boat');
  var ctx = canvas.getContext('2d');

  // L'eau du sillage est une copie du hero, déformée et floutée en CSS.
  [rim, water].forEach(function (layer) {
    var copy = stage.querySelector('.hero').cloneNode(true);
    copy.setAttribute('inert', '');
    copy.removeAttribute('aria-labelledby');
    copy.querySelectorAll('defs').forEach(function (el) { el.remove(); });
    copy.querySelectorAll('[id]').forEach(function (el) { el.removeAttribute('id'); });
    copy.querySelectorAll('a').forEach(function (el) { el.tabIndex = -1; });
    layer.appendChild(copy);
  });

  // Réglages
  var START_X = 0.84;                     // départ : 84 % de la largeur, sous le bas de l'écran
  var EXIT_X = 0.10;                      // sortie : 10 % de la largeur, au-dessus du haut
  var EXIT_AT = 0.6;                      // part du défilement où le bateau quitte l'écran
  var ANGLE_START = 19.47 * Math.PI / 180; // demi-angle du sillage (angle de Kelvin)
  var ANGLE_END = 52 * Math.PI / 180;      // le sillage s'ouvre ensuite pour couvrir l'écran
  var FOAM = '245,242,234';
  var EMPTY = 'polygon(0 0, 0 0, 0 0)';

  var W, H, diag, dpr, scale, start, dir, back, travel, heading;
  var t = 0;          // progression de 0 à 1
  var raf = 0;
  var t0 = performance.now();

  function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }
  function smooth(a, b, x) { x = clamp((x - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); }
  function rot(v, ang) {
    var c = Math.cos(ang), s = Math.sin(ang);
    return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
  }

  function measure() {
    W = stage.clientWidth;
    H = stage.clientHeight;
    diag = Math.hypot(W, H);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    scale = W < 700 ? 0.8 : 1;

    start = [W * START_X, H + 70];
    var exit = [W * EXIT_X, -70];
    var d = Math.hypot(exit[0] - start[0], exit[1] - start[1]);
    dir = [(exit[0] - start[0]) / d, (exit[1] - start[1]) / d];
    back = [-dir[0], -dir[1]];
    travel = d / EXIT_AT;
    heading = Math.atan2(dir[0], -dir[1]);
  }

  // Un bord du sillage : une droite légèrement ondulée, animée dans le temps.
  function arm(a, v, phase, time, len) {
    var nx = -v[1], ny = v[0], pts = [];
    for (var s = 0; s <= len; s += 30) {
      var k = Math.min(1, s / 220);
      var w = k * (Math.sin(s * 0.019 - time * 1.5 + phase) * 4 + Math.sin(s * 0.0071 + time * 0.8 + phase * 2) * 5);
      pts.push([a[0] + v[0] * s + nx * w, a[1] + v[1] * s + ny * w]);
    }
    return pts;
  }

  function wedge(a, theta, time) {
    var vl = rot(back, theta), vr = rot(back, -theta);
    var len = diag * 2.2, far = diag * 8;
    var L = arm(a, vl, 1, time, len), R = arm(a, vr, -1, time, len);
    var poly = L.concat(
      [[a[0] + vl[0] * far, a[1] + vl[1] * far],
       [a[0] + back[0] * far, a[1] + back[1] * far],
       [a[0] + vr[0] * far, a[1] + vr[1] * far]],
      R.slice().reverse()
    );
    return { L: L, R: R, vl: vl, vr: vr, poly: poly };
  }

  function toClip(poly) {
    return 'polygon(' + poly.map(function (p) {
      return p[0].toFixed(1) + 'px ' + p[1].toFixed(1) + 'px';
    }).join(',') + ')';
  }

  function strokeLine(pts, a, v, fadeLen, alpha0, alpha1) {
    var g = ctx.createLinearGradient(a[0], a[1], a[0] + v[0] * fadeLen, a[1] + v[1] * fadeLen);
    g.addColorStop(0, 'rgba(' + FOAM + ',' + alpha0 + ')');
    g.addColorStop(1, 'rgba(' + FOAM + ',' + alpha1 + ')');
    ctx.strokeStyle = g;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }

  function drawLines(a, theta, w, time) {
    var fade = 1 - smooth(0.88, 0.99, t);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (fade <= 0) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Bords d'écume
    ctx.setLineDash([]);
    ctx.lineWidth = 1.2;
    strokeLine(w.L, a, w.vl, 900, 0.9 * fade, 0.2 * fade);
    strokeLine(w.R, a, w.vr, 900, 0.9 * fade, 0.2 * fade);

    // Plumes intérieures, en pointillé
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 7]);
    var il = rot(back, theta * 0.5), ir = rot(back, -theta * 0.5);
    strokeLine(arm(a, il, 3, time, 540), a, il, 540, 0.5 * fade, 0);
    strokeLine(arm(a, ir, -3, time, 540), a, ir, 540, 0.5 * fade, 0);

    // Remous dans l'axe, juste derrière la poupe
    ctx.setLineDash([1, 6]);
    var p0 = [a[0] + back[0] * 62 * scale, a[1] + back[1] * 62 * scale];
    strokeLine([p0, [a[0] + back[0] * 340, a[1] + back[1] * 340]], p0, back, 280, 0.6 * fade, 0);

    // Vagues transverses : immobiles sur l'eau, elles s'élargissent quand le bateau s'éloigne
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    var dist = travel * t, spacing = 58, maxS = 1100;
    var n = [-back[1], back[0]];
    var tan = Math.tan(theta);
    for (var k = Math.max(0, Math.ceil((dist - maxS) / spacing)); k * spacing < dist; k++) {
      var s = dist - k * spacing;
      if (s < 70) continue;
      var half = s * tan * 0.72, bend = half * 0.22;
      var cx = a[0] + back[0] * s, cy = a[1] + back[1] * s;
      var alpha = 0.24 * fade * (1 - s / maxS) * Math.min(1, (s - 70) / 90);
      ctx.strokeStyle = 'rgba(' + FOAM + ',' + alpha.toFixed(3) + ')';
      ctx.beginPath();
      ctx.moveTo(cx + n[0] * half - back[0] * bend, cy + n[1] * half - back[1] * bend);
      ctx.quadraticCurveTo(
        cx + back[0] * bend, cy + back[1] * bend,
        cx - n[0] * half - back[0] * bend, cy - n[1] * half - back[1] * bend
      );
      ctx.stroke();
    }
  }

  function render(time) {
    // Position de la proue du sillage (un peu en arrière de l'étrave)
    var a = [start[0] + dir[0] * travel * t, start[1] + dir[1] * travel * t];
    var theta = ANGLE_START + (ANGLE_END - ANGLE_START) * smooth(0.3, 1, t);

    stage.classList.toggle('is-sailing', t > 0.01);
    water.style.setProperty('--alpha', (0.72 + 0.28 * smooth(0.3, 0.95, t)).toFixed(3));
    boat.style.transform =
      'translate(' + (a[0] - 15).toFixed(1) + 'px,' + (a[1] - 20).toFixed(1) + 'px) ' +
      'rotate(' + heading.toFixed(4) + 'rad) scale(' + scale + ')';

    var clip, rimClip;
    if (t <= 0) {
      clip = rimClip = EMPTY;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    } else if (t >= 0.995) {
      clip = 'none';
      rimClip = EMPTY;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    } else {
      var w = wedge(a, theta, time);
      clip = toClip(w.poly);
      // Liseré : même forme, un peu plus large et un peu en avant
      var ra = [a[0] + dir[0] * 22, a[1] + dir[1] * 22];
      rimClip = toClip(wedge(ra, theta + 0.07, time).poly);
      drawLines(a, theta, w, time);
    }
    water.style.clipPath = clip;
    content.style.clipPath = clip;
    headerLight.style.clipPath = clip;
    phareFixe.style.clipPath = clip;   // le phare n'existe que là où le sillage est passé
    rim.style.clipPath = rimClip;
  }

  function frame(now) {
    raf = 0;
    render(reduceMotion ? 0 : (now - t0) / 1000);
    // Tant que la traversée est en cours, l'eau continue d'onduler.
    if (!reduceMotion && t > 0 && t < 0.995) raf = requestAnimationFrame(frame);
  }

  function update() {
    var r = voyage.getBoundingClientRect();
    var span = r.height - H;
    t = span > 0 ? clamp(-r.top / span, 0, 1) : 1;
    updateCounters();
    if (!raf) raf = requestAnimationFrame(frame);
  }

  // ---------- 3. Résultats : cartes, graphiques et compteurs ----------
  // Chaque carte avance avec le défilement, avec un léger décalage entre elles.
  // --p (0 → 1) pilote en CSS la courbe, les barres, l'anneau et la jauge.
  var cards = Array.prototype.slice.call(document.querySelectorAll('[data-kpi]')).map(function (el) {
    return { el: el, counters: Array.prototype.slice.call(el.querySelectorAll('[data-count]')) };
  });
  var lastT = -1;

  function updateCounters() {
    if (t === lastT) return;
    lastT = t;
    cards.forEach(function (c, k) {
      var p = reduceMotion ? 1 : smooth(0.14 + 0.07 * k, 0.62 + 0.07 * k, t);
      c.el.style.setProperty('--p', p.toFixed(4));
      c.counters.forEach(function (el) {
        var dec = parseInt(el.dataset.decimals || '0', 10);
        el.textContent = (parseFloat(el.dataset.count) * p)
          .toLocaleString('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
      });
    });
  }

  // ---------- 4. Mouette (arrivée) + Fonctionnement ----------
  var escale = document.querySelector('.escale');
  var pourqui = escale.querySelector('.pourqui');
  var phare = escale.querySelector('.phare');
  var pStage = phare.querySelector('.phare__stage');
  var pAnchor = phare.querySelector('.phare__anchor');
  var fonct = phare.querySelector('.fonct');
  var mouette = pStage.querySelector('.mouette');
  var phareFixe = document.querySelector('.phare-fixe');
  var phareIn = phareFixe.querySelector('.phare-fixe__in');
  var grille = fonct.querySelector('.fonct__grille');
  var systeme = fonct.querySelector('.fonct__systeme');
  var niveau = fonct.querySelector('.fonct__niveau');
  var phrases = Array.prototype.slice.call(fonct.querySelectorAll('.fonct__phrases li'));
  var compteurs = {};
  fonct.querySelectorAll('[data-compteur]').forEach(function (el) { compteurs[el.dataset.compteur] = el; });

  // Réglages
  var PALIERS = [1, 6, 18, 40];   // nombre de cases allumées à la fin de chaque étape
  var TOTAL = 40;
  // Ce que contient chaque case, dans l'ordre d'allumage
  var TYPES = [];
  (function () {
    var formats = ['faq', 'data', 'video', 'faq', 'data', 'article'];
    var portee = ['ia', 'person', 'person', 'ia', 'article', 'person', 'faq', 'ia', 'person', 'data', 'person'];
    for (var k = 0; k < TOTAL; k++) {
      TYPES.push(k < 6 ? 'article' : k < 18 ? formats[(k - 6) % formats.length] : portee[(k - 18) % portee.length]);
    }
  })();

  var PW, PH, lineX = 0, flashSpan, pTotal, cases = [];
  var lastN = -1, lastStep = -1;

  // Cases hors de la zone nette : part qui finit par s'allumer, et ce qu'elles contiennent
  var PART_FLOUE = 0.26;
  var RAYON_NET = 5.2;      // rayon (en cases) de la zone parfaitement nette autour du point
  var ETENDUE_FLOU = 4;  // nombre de cases sur lequel la netteté se perd
  var BLUR_MAX = 7;         // flou maximal, en pixels
  var TYPES_FLOUS = ['article', 'faq', 'person', 'data', 'ia', 'article', 'person', 'video'];
  var flous = [];        // { el, seuil } : cases du flou qui s'allument quand g dépasse leur seuil
  var gridKey = '';

  function hash(x, y) {
    var v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return v - Math.floor(v);
  }
  function fillCase(el, type) {
    el.dataset.type = type;
    el.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-' + type + '"/></svg>';
  }

  // La grille : une zone nette de 40 cases (alignée sur le point, remplie depuis lui),
  // entourée de cases de plus en plus floues qui débordent de l'écran.
  function layoutGrid() {
    var mobile = PW <= 860;
    var nCols = mobile ? 5 : 8, rows = TOTAL / nCols, gap = mobile ? 8 : 12;
    lineX = mobile ? 28 : PW * 0.42;
    var ecart = mobile ? 22 : 56;
    var originRow = mobile ? 3 : 2;
    var dotY = PH * (mobile ? 0.6 : 0.5);
    var availW = PW - lineX - ecart - (mobile ? 20 : 40);
    var cell = Math.floor(Math.min(
      64,
      (availW - (nCols - 1) * gap) / nCols,
      (PH * (mobile ? 0.5 : 0.52) - (rows - 1) * gap) / rows
    ));
    capY = dotY;
    var pitch = cell + gap;
    var coreLeft = lineX + ecart;
    var coreTop = dotY - originRow * pitch - cell / 2;

    // Cases en plus : à droite, au-dessus et en dessous, jusqu'au-delà des bords de l'écran
    var extra = Math.max(1, Math.ceil((PW - (coreLeft + nCols * pitch)) / pitch) + 1);
    var above = Math.max(1, Math.ceil(coreTop / pitch) + 1);
    var below = Math.max(1, Math.ceil((PH - (coreTop + rows * pitch)) / pitch) + 1);

    fonct.style.setProperty('--cols', nCols + extra);
    fonct.style.setProperty('--cell', cell + 'px');
    fonct.style.setProperty('--gap', gap + 'px');
    fonct.style.setProperty('--gtop', Math.round(coreTop - above * pitch) + 'px');

    var key = [nCols, extra, above, below].join('-');
    if (key === gridKey) return;
    gridKey = key;

    grille.textContent = '';
    flous = [];
    // Distance de chaque case au point, en « cases ». La forme est un demi-ovale
    // (plus large que haut sur ordinateur), avec un peu d'irrégularité pour un bord naturel.
    var wx = mobile ? 1 : 0.65, wy = mobile ? 1 : 1.5;
    var fx = mobile ? 1 : 0.8;     // le flou arrive un peu plus vite vers la droite
    var all = [];
    for (var r = 0; r < above + rows + below; r++) {
      for (var c = 0; c < nCols + extra; c++) {
        var el = document.createElement('div');
        el.className = 'case';
        grille.appendChild(el);
        var y = r - above - originRow;
        var dist = Math.hypot(c * wx, y * wy);
        var h = hash(c, r), h2 = hash(c + 17, r + 5);
        all.push({
          el: el, h: h, h2: h2,
          ordre: dist + (h - 0.5) * 0.9 * Math.min(1, dist),        // ordre de remplissage
          flou: Math.hypot(c * fx, y * wy) + (h2 - 0.5) * 0.8       // distance utilisée pour le flou
        });
      }
    }
    all.sort(function (a, b) { return a.ordre - b.ordre; });

    // Les 40 premières cases forment le système, toujours net ; au-delà, la netteté se perd peu à peu.
    cases = [];
    all.forEach(function (o, k) {
      var u = k < TOTAL ? 0 : smooth(RAYON_NET, RAYON_NET + ETENDUE_FLOU, o.flou);   // 0 = net, 1 = très flou
      var blur = BLUR_MAX * Math.pow(u, 1.3);
      o.el.style.filter = blur > 0.15 ? 'blur(' + blur.toFixed(2) + 'px)' : '';
      o.el.style.opacity = (1 - 0.85 * u).toFixed(3);
      if (k < TOTAL) {
        fillCase(o.el, TYPES[k]);
        cases.push(o.el);
      } else {
        fillCase(o.el, TYPES_FLOUS[Math.floor(o.h2 * TYPES_FLOUS.length)]);
        // Quelques cases s'allument aussi dans le flou, les plus proches d'abord
        if (u > 0.3 && o.h < PART_FLOUE) {
          flous.push({ el: o.el, seuil: Math.min(0.96, 0.26 + 0.5 * u + 0.2 * o.h2) });
        }
      }
    });
    lastN = -1;
  }

  function measurePhare() {
    PW = pStage.clientWidth;
    PH = pStage.clientHeight;
    escale.style.setProperty('--pq-h', pourqui.offsetHeight + 'px');
    measurePourqui();
    flashSpan = pAnchor.offsetTop;
    pTotal = phare.offsetHeight - PH;
    layoutGrid();
  }

  var cap = fonct.querySelector('.cap');
  var capY = 0;

  // L'arrivée (f de 0 à 1, pendant que l'écran est figé) :
  // 1. la mouette entre par le haut, au centre, et descend jusqu'à sa place sur la ligne directrice ;
  // 2. derrière elle, l'écran devient blanc : la section blanche se déroule par-dessus « Pour qui »
  //    (et recouvre le phare) ; une fois la mouette posée, le blanc finit de couler jusqu'en bas ;
  // 3. le contenu de la section apparaît.
  function renderArrivee(f) {
    var a = smooth(0.04, 0.62, f);                      // descente de la mouette
    var y0 = -40;
    var gy = y0 + (capY - y0) * a;
    var gx = PW / 2 + (lineX - PW / 2) * a;             // part du centre de l'écran et glisse vers la ligne directrice
    mouette.style.transform = 'translate(' + gx.toFixed(1) + 'px,' + gy.toFixed(1) + 'px)';
    mouette.style.visibility = f > 0 ? 'visible' : 'hidden';

    // Bord du blanc : juste derrière la mouette, puis jusqu'en bas de l'écran
    var edge = Math.max(0, gy - 18);
    edge += (PH - edge) * smooth(0.64, 0.9, f);
    if (f <= 0) edge = 0;
    fonct.style.clipPath = edge >= PH - 0.5 ? 'none' : 'inset(0 0 ' + (PH - edge).toFixed(1) + 'px 0)';
    phareIn.style.clipPath = edge > 0 ? 'inset(' + edge.toFixed(1) + 'px 0 0 0)' : '';

    fonct.style.setProperty('--c', smooth(0.84, 1, f).toFixed(3));
    cap.style.setProperty('--by', capY.toFixed(1) + 'px');
    pStage.classList.toggle('is-on', edge > PH * 0.5);
    // Menu en encre sur le blanc, de nouveau clair quand la section Rendez-vous (sombre) arrive
    header.classList.toggle('header--ink', edge > 38 && rdv.getBoundingClientRect().top > 38);
  }

  // Les étapes : le texte change, les graduations défilent, les cases se remplissent.
  function renderSteps(g) {
    var local = g * PALIERS.length;
    var i = Math.min(PALIERS.length - 1, Math.floor(local));
    var fr = clamp(local - i, 0, 1);
    var prev = i ? PALIERS[i - 1] : 0;
    var n = g >= 1 ? TOTAL : Math.round(prev + (PALIERS[i] - prev) * smooth(0, 0.6, fr));

    fonct.style.setProperty('--g', g.toFixed(4));
    // Dans le flou, quelques cases s'allument aussi : le système continue hors champ.
    flous.forEach(function (o) { o.el.classList.toggle('on', g >= o.seuil); });

    if (i !== lastStep) {
      lastStep = i;
      phrases.forEach(function (p, k) { p.classList.toggle('is-active', k === i); });
      niveau.textContent = 'Étape ' + (i + 1) + ' sur ' + PALIERS.length + ' : ' + phrases[i].dataset.nom;
    }
    if (n !== lastN) {
      lastN = n;
      var totals = { article: 0, format: 0, ia: 0, person: 0 };
      cases.forEach(function (el, k) {
        var on = k < n;
        el.classList.toggle('on', on);
        if (on) {
          var type = TYPES[k];
          totals[type === 'faq' || type === 'data' || type === 'video' ? 'format' : type]++;
        }
      });
      Object.keys(totals).forEach(function (key) { compteurs[key].textContent = totals[key]; });
    }
  }

  function updatePhare() {
    var top = phare.getBoundingClientRect().top;
    var sc = clamp(-top, 0, pTotal);
    renderArrivee(clamp(sc / flashSpan, 0, 1));
    renderSteps(clamp((sc - flashSpan) / (pTotal - flashSpan), 0, 1));
  }

  // ---------- 5. Rendez-vous : agenda de démonstration ----------
  // MAQUETTE : rien n'est envoyé ni enregistré. Les disponibilités sont inventées
  // (jours ouvrés, créneaux de 30 min). À remplacer par un vrai outil de réservation.
  var rdv = document.querySelector('.rdv');
  (function () {
    var agenda = document.getElementById('agenda');
    var choix = agenda.querySelector('.agenda__choix');
    var moisEl = agenda.querySelector('.agenda__mois p');
    var navs = agenda.querySelectorAll('.agenda__nav');
    var joursEl = agenda.querySelector('.agenda__jours');
    var jourEl = agenda.querySelector('.agenda__jour');
    var listeEl = agenda.querySelector('.agenda__liste');
    var form = agenda.querySelector('.agenda__form');
    var recap = agenda.querySelector('.agenda__recap span');
    var ok = agenda.querySelector('.agenda__ok');
    var okTexte = agenda.querySelector('.agenda__ok-texte');

    var MOIS_MAX = 2;   // on peut réserver jusqu'à 2 mois plus tard
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var view = new Date(today.getFullYear(), today.getMonth(), 1);
    var selected = null, heure = '';

    function isOpen(d) { var wd = d.getDay(); return d > today && wd !== 0 && wd !== 6; }
    function sameDay(a, b) { return a && b && a.getTime() === b.getTime(); }
    function monthIndex(d) { return d.getFullYear() * 12 + d.getMonth(); }
    function longDate(d) { return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }); }

    function slotsFor(d) {
      var out = [];
      for (var m = 9 * 60, i = 0; m <= 17 * 60 + 30; m += 30, i++) {
        if (m >= 12 * 60 && m < 14 * 60) continue;                 // pause déjeuner
        if (hash(d.getDate() + d.getMonth() * 31, i) < 0.45) continue; // créneau « déjà pris »
        out.push(('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2));
      }
      return out.length ? out : ['10:00', '14:30', '16:00'];
    }

    function renderMonth() {
      moisEl.textContent = view.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
      navs[0].disabled = monthIndex(view) <= monthIndex(today);
      navs[1].disabled = monthIndex(view) >= monthIndex(today) + MOIS_MAX;
      joursEl.textContent = '';
      var offset = (view.getDay() + 6) % 7;   // la semaine commence le lundi
      for (var i = 0; i < offset; i++) joursEl.appendChild(document.createElement('span'));
      var count = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
      for (var n = 1; n <= count; n++) {
        var d = new Date(view.getFullYear(), view.getMonth(), n);
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = n;
        b.disabled = !isOpen(d);
        b.dataset.jour = n;
        b.setAttribute('aria-label', longDate(d));
        b.setAttribute('aria-pressed', sameDay(d, selected) ? 'true' : 'false');
        joursEl.appendChild(b);
      }
    }

    function renderSlots() {
      listeEl.textContent = '';
      jourEl.textContent = selected ? longDate(selected) : 'Choisissez un jour';
      if (!selected) return;
      slotsFor(selected).forEach(function (s) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = s;
        listeEl.appendChild(b);
      });
    }

    function show(step) {
      choix.hidden = step !== 'choix';
      form.hidden = step !== 'form';
      ok.hidden = step !== 'ok';
    }

    // Premier jour disponible sélectionné d'office : les créneaux sont visibles tout de suite
    var first = new Date(today);
    do { first.setDate(first.getDate() + 1); } while (!isOpen(first));
    selected = first;
    view = new Date(first.getFullYear(), first.getMonth(), 1);
    renderMonth();
    renderSlots();

    navs.forEach(function (b) {
      b.addEventListener('click', function () {
        view = new Date(view.getFullYear(), view.getMonth() + parseInt(b.dataset.dir, 10), 1);
        renderMonth();
      });
    });
    joursEl.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b || b.disabled) return;
      selected = new Date(view.getFullYear(), view.getMonth(), parseInt(b.dataset.jour, 10));
      renderMonth();
      renderSlots();
    });
    listeEl.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      heure = b.textContent;
      recap.textContent = longDate(selected) + ' à ' + heure + ' · 30 min';
      show('form');
      form.querySelector('input').focus();
    });
    agenda.querySelector('.agenda__modifier').addEventListener('click', function () { show('choix'); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      // MAQUETTE : c'est ici qu'il faudra envoyer la demande au vrai outil de réservation.
      okTexte.textContent = 'Rendez-vous le ' + longDate(selected) + ' à ' + heure +
        '. Vous recevrez le lien de la visio à ' + form.elements.email.value + '.';
      show('ok');
      ok.focus();
    });
  })();

  // ---------- 6. Pour qui : épinglage + textes qui s'assoient ----------
  // La section se fige au centre de l'écran (ou en bas si elle est plus haute que l'écran)
  // pendant PAUSE × hauteur d'écran, avant l'arrivée de la mouette. Pendant ce temps, titres et
  // lignes se posent un par un. L'animation suit le défilement : elle s'inverse si on remonte.
  var PAUSE = 1.4;
  var pause = escale.querySelector('.escale__pause');
  var assis = [];
  (function () {
    var cols = pourqui.querySelectorAll('.pourqui__col');
    var liste = [{ el: pourqui.querySelector('h2'), delai: 0 }];
    cols.forEach(function (col, c) {
      liste.push({ el: col, delai: c * 40, cadre: true });
      liste.push({ el: col.querySelector('h3'), delai: c * 40 + 20 });
      col.querySelectorAll('li').forEach(function (li) { liste.push({ el: li, delai: c * 40 + 30 }); });
    });
    assis = liste;
  })();

  function measurePourqui() {
    var vh = window.innerHeight, h = pourqui.offsetHeight;
    var top = h <= vh ? (vh - h) / 2 : vh - h;      // centré si possible, sinon aligné en bas
    escale.style.setProperty('--pq-top', top + 'px');
    pause.style.height = Math.round(PAUSE * vh + Math.max(0, (vh - h) / 2)) + 'px';
    var base = pourqui.getBoundingClientRect().top;
    assis.forEach(function (o) { o.y = o.el.getBoundingClientRect().top - base; });
  }

  var lastPq = null;
  function updatePourqui() {
    var vh = window.innerHeight;
    var y0 = escale.getBoundingClientRect().top;   // position « libre », comme si rien n'était épinglé
    var key = Math.round(y0);
    if (key === lastPq) return;
    lastPq = key;
    assis.forEach(function (o) {
      // L'élément se pose quand sa position libre passe de 92 % à 62 % de la hauteur d'écran.
      var y = y0 + o.y + o.delai;
      var r = reduceMotion ? 1 : 1 - smooth(0.62 * vh, 0.92 * vh, y);
      o.el.style.setProperty('--r', r.toFixed(3));
    });
  }

  // ---------- Démarrage ----------
  function onScroll() { update(); updatePourqui(); updatePhare(); }
  function onResize() { measure(); measurePhare(); onScroll(); }

  measure();
  measurePhare();
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  window.addEventListener('load', onResize);
  if (window.ResizeObserver) new ResizeObserver(onResize).observe(pourqui);
})();
