/* =========================================================================
   SILLAGE — Eau claire vue d'en haut, en fond du hero (WebGL 2)

   Deux parties :
   1. Une simulation de surface (grille 256 × 256, sur la carte graphique) :
      chaque passage de souris dépose une « goutte », les vagues se propagent,
      rebondissent doucement et s'amortissent jusqu'au calme.
   2. Un rendu : on regarde un fond pâle à travers l'eau. La pente des vagues
      dévie la lumière (réfraction), dessine des reflets lumineux au fond
      (caustiques) et quelques reflets à la surface.

   Les caustiques bougent lentement en permanence, comme une vraie eau.
   Le rendu s'arrête quand le hero n'est plus à l'écran ou que l'onglet est caché.
   Sans WebGL 2, rien ne se passe : la couleur de fond du hero reste.
   ========================================================================= */
(function () {
  'use strict';

  var hero = document.querySelector('.hero');
  var canvas = hero && hero.querySelector('.hero__eau');
  if (!canvas) return;

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false });
  if (!gl) return;
  if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return;

  var SIM = 256;            // résolution de la simulation
  var QUALITE = 0.75;       // le rendu est calculé un peu plus petit puis agrandi (l'eau est douce)

  // ---------- Shaders ----------
  var VS = '#version 300 es\n' +
    'in vec2 p; out vec2 uv;\n' +
    'void main(){ uv = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }';

  // Goutte : creuse la surface autour du point (forme en cosinus, douce)
  var FS_GOUTTE = '#version 300 es\nprecision highp float;\n' +
    'in vec2 uv; out vec4 o;\n' +
    'uniform sampler2D sim; uniform vec2 centre; uniform float rayon, force, aspect;\n' +
    'void main(){\n' +
    '  vec4 v = texture(sim, uv);\n' +
    '  float d = length((uv - centre) * vec2(aspect, 1.));\n' +
    '  float g = max(0., 1. - d / rayon);\n' +
    '  g = .5 - cos(g * 3.14159265) * .5;\n' +
    '  v.r -= g * force;\n' +
    '  o = v;\n' +
    '}';

  // Propagation : équation des ondes (hauteur r, vitesse g) + amortissement
  var FS_ONDE = '#version 300 es\nprecision highp float;\n' +
    'in vec2 uv; out vec4 o;\n' +
    'uniform sampler2D sim; uniform vec2 px;\n' +
    'void main(){\n' +
    '  vec4 v = texture(sim, uv);\n' +
    '  float moy = (texture(sim, uv - vec2(px.x, 0.)).r + texture(sim, uv + vec2(px.x, 0.)).r +\n' +
    '               texture(sim, uv - vec2(0., px.y)).r + texture(sim, uv + vec2(0., px.y)).r) * .25;\n' +
    '  v.g += (moy - v.r) * 2.;\n' +
    '  v.g *= .986;\n' +
    '  v.r += v.g;\n' +
    '  v.r *= .9985;\n' +
    '  o = v;\n' +
    '}';

  // Rendu : fond pâle vu à travers l'eau
  var FS_RENDU = '#version 300 es\nprecision highp float;\n' +
    'in vec2 uv; out vec4 o;\n' +
    'uniform sampler2D sim; uniform vec2 px; uniform float t, aspect;\n' +

    // Bruit doux pour le grain du fond (sable très fin, à peine visible)
    'float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }\n' +
    'float bruit(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);\n' +
    '  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }\n' +

    // Caustiques : le réseau de lignes lumineuses d'un fond de piscine.
    // On découpe le plan en cellules dont les centres dérivent lentement ; la lumière se concentre
    // là où deux cellules se touchent (F2 - F1 proche de 0).
    'vec2 h22(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }\n' +
    'float cellules(vec2 x, float t){\n' +
    '  vec2 n = floor(x), f = fract(x); float f1 = 8., f2 = 8.;\n' +
    '  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {\n' +
    '    vec2 g = vec2(float(i), float(j));\n' +
    '    vec2 o = h22(n + g); o = .5 + .42 * sin(t + 6.2831 * o);\n' +
    '    float d = length(g + o - f);\n' +
    '    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }\n' +
    '  }\n' +
    '  return f2 - f1;\n' +
    '}\n' +
    'float caustique(vec2 p, float t){\n' +
    '  p += .22 * vec2(sin(p.y * 1.3 + t * .7), cos(p.x * 1.1 + t * .6));\n' +   // ondulation organique
    '  return exp(-cellules(p, t) * 7.5);\n' +
    '}\n' +

    'void main(){\n' +
    // Pente de la surface → normale
    '  float hC = texture(sim, uv).r;\n' +
    '  float hL = texture(sim, uv - vec2(px.x, 0.)).r, hR = texture(sim, uv + vec2(px.x, 0.)).r;\n' +
    '  float hD = texture(sim, uv - vec2(0., px.y)).r, hU = texture(sim, uv + vec2(0., px.y)).r;\n' +
    '  vec3 n = normalize(vec3((hL - hR) * 14., (hD - hU) * 14., 1.));\n' +
    '  float courbure = hL + hR + hD + hU - 4. * hC;\n' +

    // Réfraction : le fond est vu légèrement décalé selon la pente
    '  vec2 q = uv * vec2(aspect, 1.);\n' +
    '  vec2 fondUV = q + n.xy * .32;\n' +

    // Le fond : blanc cassé, grain de sable très fin
    '  float grain = bruit(fondUV * 380.) * .5 + bruit(fondUV * 90.) * .5;\n' +
    '  vec3 fond = vec3(.955, .952, .935) - grain * .018;\n' +

    // Les reflets lumineux au fond : deux couches à des échelles différentes, très lentes
    '  float ca = caustique(fondUV * 6.5 + vec2(13.1, 7.7), t * .3);\n' +
    '  float cb = caustique(fondUV * 10.5 + vec2(3.3, 21.4), t * .25 + 4.);\n' +
    '  float c = ca * .7 + cb * .45;\n' +
    // Les vagues concentrent ou dispersent la lumière (creux = plus de lumière)
    '  c += clamp(-courbure * 40., -.45, 1.1);\n' +

    // Couleur de l'eau : lagon très clair, un peu plus soutenu en bas à droite
    '  float prof = smoothstep(.0, 1.2, uv.x * .6 + (1. - uv.y) * .5);\n' +
    '  vec3 eau = mix(vec3(.80, .905, .925), vec3(.70, .85, .89), prof);\n' +
    '  vec3 col = mix(fond, fond * eau, .62);\n' +
    '  col += vec3(.96, 1., 1.) * c * .28;\n' +

    // Ombre portée des vagues sur le fond (légère) et reflet du ciel sur les pentes
    '  col -= vec3(.07, .05, .04) * clamp(courbure * 30., 0., 1.);\n' +
    '  vec3 L = normalize(vec3(-.35, .45, 1.));\n' +
    '  vec3 r = reflect(vec3(0., 0., -1.), n);\n' +
    '  float spec = pow(max(dot(r, L), 0.), 60.) * smoothstep(.004, .04, length(n.xy));\n' +
    '  col += spec * .6;\n' +

    // Vignette très douce pour garder le texte lisible à gauche
    '  col = mix(col, vec3(.955, .955, .94), .18 * (1. - smoothstep(.0, .55, uv.x)));\n' +
    '  o = vec4(col, 1.);\n' +
    '}';

  // ---------- Outils WebGL ----------
  function shader(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function programme(fs) {
    var p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) { var nom = gl.getActiveUniform(p, i).name; u[nom] = gl.getUniformLocation(p, nom); }
    return { p: p, u: u };
  }
  function cible() {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, SIM, SIM, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex: tex, fb: fb };
  }

  var pGoutte, pOnde, pRendu, A, B;
  try {
    pGoutte = programme(FS_GOUTTE);
    pOnde = programme(FS_ONDE);
    pRendu = programme(FS_RENDU);
    A = cible(); B = cible();
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return;
  } catch (e) { return; }

  var quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // Passe de simulation : lit A, écrit B, puis échange
  function passe(prog, reglages) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, B.fb);
    gl.viewport(0, 0, SIM, SIM);
    gl.useProgram(prog.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, A.tex);
    gl.uniform1i(prog.u.sim, 0);
    reglages(prog.u);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    var t = A; A = B; B = t;
  }

  // ---------- Taille ----------
  var W = 1, H = 1, aspect = 1;
  function taille() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(hero.clientWidth * dpr * QUALITE));
    H = Math.max(1, Math.round(hero.clientHeight * dpr * QUALITE));
    canvas.width = W; canvas.height = H;
    aspect = hero.clientWidth / Math.max(1, hero.clientHeight);
  }

  // ---------- Gouttes sous la souris ----------
  var gouttes = [];
  var dernier = null;
  function ajouter(x, y, force, rayon) {
    if (gouttes.length < 12) gouttes.push({ x: x, y: y, f: force, r: rayon });
  }
  hero.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'touch') return;      // au doigt, on laisse défiler la page
    var r = hero.getBoundingClientRect();
    var x = (e.clientX - r.left) / r.width, y = 1 - (e.clientY - r.top) / r.height;
    if (dernier) {
      var d = Math.hypot((x - dernier.x) * aspect, y - dernier.y);
      if (d < 0.006) return;
      // Plus le geste est rapide, plus la vague est marquée (plafonné)
      ajouter(x, y, Math.min(0.07, 0.02 + d * 1.1), 0.028);
    }
    dernier = { x: x, y: y };
  }, { passive: true });
  hero.addEventListener('pointerleave', function () { dernier = null; });
  // Au doigt : un toucher fait une goutte
  hero.addEventListener('pointerdown', function (e) {
    var r = hero.getBoundingClientRect();
    ajouter((e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height, 0.09, 0.035);
  }, { passive: true });

  // ---------- Boucle ----------
  var visible = true, raf = 0, t0 = performance.now(), tFige = 7.5;

  function image(now) {
    raf = 0;
    var t = reduceMotion ? tFige : tFige + (now - t0) / 1000;

    // Gouttes en attente, puis deux pas de propagation par image
    while (gouttes.length) {
      var g = gouttes.shift();
      passe(pGoutte, function (u) {
        gl.uniform2f(u.centre, g.x, g.y);
        gl.uniform1f(u.rayon, g.r);
        gl.uniform1f(u.force, g.f);
        gl.uniform1f(u.aspect, aspect);
      });
    }
    for (var k = 0; k < 2; k++) {
      passe(pOnde, function (u) { gl.uniform2f(u.px, 1 / SIM, 1 / SIM); });
    }

    // Rendu à l'écran
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(pRendu.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, A.tex);
    gl.uniform1i(pRendu.u.sim, 0);
    gl.uniform2f(pRendu.u.px, 1 / SIM, 1 / SIM);
    gl.uniform1f(pRendu.u.t, t);
    gl.uniform1f(pRendu.u.aspect, aspect);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    if (!canvas.classList.contains('is-ready')) canvas.classList.add('is-ready');
    if (visible && !document.hidden && !reduceMotion) raf = requestAnimationFrame(image);
  }
  function relancer() { if (!raf && visible && !document.hidden) raf = requestAnimationFrame(image); }

  taille();
  window.addEventListener('resize', function () { taille(); relancer(); });
  document.addEventListener('visibilitychange', relancer);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entrees) {
      visible = entrees[0].isIntersecting;
      relancer();
    }).observe(hero);
  }
  // Avec « réduire les animations » : une seule image fixe (et une à chaque goutte)
  if (reduceMotion) hero.addEventListener('pointermove', relancer, { passive: true });
  relancer();
})();
