(function () {

  // ── 1. Animated film grain / washi paper texture ──────────────────────────
  (function initGrain() {
    const sz = 250;
    const off = document.createElement('canvas');
    off.width = sz; off.height = sz;
    const gx = off.getContext('2d');
    const img = gx.createImageData(sz, sz);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    gx.putImageData(img, 0, 0);

    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:9999;opacity:0.032;' +
      `background-image:url(${off.toDataURL()});background-size:${sz}px ${sz}px;` +
      'animation:_grain .2s steps(1) infinite;';
    document.body.appendChild(el);

    const s = document.createElement('style');
    s.textContent =
      '@keyframes _grain{' +
      '0%{background-position:0 0}' +
      '20%{background-position:-80px -30px}' +
      '40%{background-position:30px -90px}' +
      '60%{background-position:-60px 50px}' +
      '80%{background-position:70px 80px}' +
      '100%{background-position:0 0}}';
    document.head.appendChild(s);
  })();

  // ── 2. Soft watercolor blobs (behind particles) ───────────────────────────
  (function initBlobs() {
    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:-2;filter:blur(80px);';
    document.body.prepend(cv);
    const cx = cv.getContext('2d');

    const resize = () => { cv.width = innerWidth; cv.height = innerHeight; };
    resize(); addEventListener('resize', resize);

    const blobs = [
      { nx: 0.18, ny: 0.25, vx: 0.00011, vy:  0.00007, r: 0.30, h: 200, s: 55, l: 80 },
      { nx: 0.78, ny: 0.55, vx:-0.00009, vy:  0.00013, r: 0.24, h: 340, s: 60, l: 85 },
      { nx: 0.50, ny: 0.88, vx: 0.00007, vy: -0.00011, r: 0.27, h: 145, s: 45, l: 82 },
      { nx: 0.88, ny: 0.18, vx:-0.00013, vy:  0.00009, r: 0.21, h:  45, s: 55, l: 87 },
    ];

    (function frame() {
      cx.clearRect(0, 0, cv.width, cv.height);
      const dark = document.documentElement.dataset.theme === 'dark';
      blobs.forEach(b => {
        b.nx += b.vx; b.ny += b.vy;
        if (b.nx < 0 || b.nx > 1) b.vx *= -1;
        if (b.ny < 0 || b.ny > 1) b.vy *= -1;
        const bx = b.nx * cv.width, by = b.ny * cv.height;
        const br = b.r * Math.min(cv.width, cv.height);
        const l = dark ? 22 : b.l;
        const a = dark ? 0.5 : 0.62;
        const g = cx.createRadialGradient(bx, by, 0, bx, by, br);
        g.addColorStop(0, `hsla(${b.h},${b.s}%,${l}%,${a})`);
        g.addColorStop(1, `hsla(${b.h},${b.s}%,${l}%,0)`);
        cx.beginPath(); cx.arc(bx, by, br, 0, Math.PI * 2);
        cx.fillStyle = g; cx.fill();
      });
      requestAnimationFrame(frame);
    })();
  })();

  // ── 3. Cursor glow trail ──────────────────────────────────────────────────
  (function initCursorTrail() {
    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9998;';
    document.body.appendChild(cv);
    const cx = cv.getContext('2d');

    const resize = () => { cv.width = innerWidth; cv.height = innerHeight; };
    resize(); addEventListener('resize', resize);

    const trail = [];
    addEventListener('mousemove', e => {
      const now = performance.now();
      const last = trail[trail.length - 1];
      // Interpolate intermediate points so fast movement leaves no gaps
      if (last) {
        const dx = e.clientX - last.x;
        const dy = e.clientY - last.y;
        const steps = Math.ceil(Math.hypot(dx, dy) / 5);
        for (let i = 1; i < steps; i++) {
          const t = i / steps;
          trail.push({ x: last.x + dx * t, y: last.y + dy * t, t: last.t + (now - last.t) * t });
        }
      }
      trail.push({ x: e.clientX, y: e.clientY, t: now });
    });

    const TTL = 420;
    (function frame(now) {
      cx.clearRect(0, 0, cv.width, cv.height);
      while (trail.length && now - trail[0].t > TTL) trail.shift();

      if (trail.length >= 2) {
        cx.save();
        cx.lineCap = 'round';
        cx.lineJoin = 'round';
        for (let i = 1; i < trail.length; i++) {
          const p0 = trail[i - 1];
          const p1 = trail[i];
          const life = 1 - (now - p1.t) / TTL;
          cx.beginPath();
          cx.moveTo(p0.x, p0.y);
          cx.lineTo(p1.x, p1.y);
          cx.strokeStyle = `rgba(110,185,235,${life * 0.6})`;
          cx.lineWidth = Math.max(0.5, life * 2.5);
          cx.stroke();
        }
        cx.restore();
      }
      requestAnimationFrame(frame);
    })(performance.now());
  })();

  // ── 4. Scroll-reveal for sections ─────────────────────────────────────────
  (function initScrollReveal() {
    document.body.classList.add('js-reveal');
    const obs = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('visible');
          obs.unobserve(e.target);
        }
      });
    }, { threshold: 0.12 });
    document.querySelectorAll('section').forEach((s, i) => {
      s.style.transitionDelay = `${i * 0.07}s`;
      obs.observe(s);
    });
  })();

  // ── 5. Name draw → breathe transition ────────────────────────────────────
  (function initNameDraw() {
    const svg = document.querySelector('.name-svg');
    if (!svg) return;
    // sweep is 1.5s + 0.4s delay = 1.9s; add buffer
    setTimeout(() => {
      svg.style.clipPath = 'none';
      svg.style.animation = 'name-breathe 5s ease-in-out infinite';
    }, 2150);
  })();

  // ── 6. Typewriter for tagline ─────────────────────────────────────────────
  (function initTypewriter() {
    const el = document.querySelector('.tagline');
    if (!el) return;
    const full = el.textContent.trim();
    el.textContent = '';
    let i = 0;
    function tick() {
      el.textContent = full.slice(0, i++);
      if (i <= full.length) setTimeout(tick, 55 + Math.random() * 35);
    }
    setTimeout(tick, 950); // start after name finishes drawing
  })();

  // ── 7. Sliding nav underline indicator ────────────────────────────────────
  (function initNavIndicator() {
    const nav = document.querySelector('nav');
    if (!nav) return;
    const bar = document.createElement('span');
    bar.className = 'nav-indicator';
    nav.appendChild(bar);

    const links = [...nav.querySelectorAll('a')];
    const active = nav.querySelector('a.active');

    function moveTo(el) {
      const nr = nav.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      bar.style.left  = (er.left - nr.left) + 'px';
      bar.style.width = er.width + 'px';
      bar.style.opacity = '1';
    }

    if (active) {
      bar.style.transition = 'none';
      moveTo(active);
      bar.getBoundingClientRect(); // force reflow
      bar.style.transition = '';
    }

    links.forEach(a => {
      a.addEventListener('mouseenter', () => moveTo(a));
      a.addEventListener('mouseleave', () => active ? moveTo(active) : (bar.style.opacity = '0'));
    });
  })();

  // ── 8. Day / Night toggle ─────────────────────────────────────────────────
  (function initTheme() {
    const root = document.documentElement;
    if (localStorage.getItem('alex-theme') === 'dark') root.dataset.theme = 'dark';

    const btn = document.getElementById('theme-toggle');
    if (!btn) return;

    const updateIcon = () => { btn.textContent = root.dataset.theme === 'dark' ? '☀' : '☾'; };
    updateIcon();

    btn.addEventListener('click', () => {
      root.dataset.theme = root.dataset.theme === 'dark' ? '' : 'dark';
      localStorage.setItem('alex-theme', root.dataset.theme);
      updateIcon();
    });
  })();

})();
