/* Photo book: builds the sheets from window.BOOK_PHOTOS and animates them. */
(function () {
  'use strict';

  const scene = document.getElementById('book-scene');
  if (!scene) return;

  const PHOTOS  = Array.isArray(window.BOOK_PHOTOS) ? window.BOOK_PHOTOS : [];
  const shift   = scene.querySelector('.book-shift');
  const book    = scene.querySelector('.book');
  const counter = document.getElementById('book-counter');
  const btnPrev = document.getElementById('book-prev');
  const btnNext = document.getElementById('book-next');

  const reduce   = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse   = matchMedia('(pointer: coarse)').matches;
  const singleMQ = matchMedia('(max-width: 640px)');

  const T      = 2;   // px of thickness per sheet
  const BASE_X = 6;   // resting tilt (deg): we look slightly down onto the book

  const clamp     = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const easeInOut = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut   = t => 1 - Math.pow(1 - t, 3);
  const esc       = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  /* ── Page faces, in reading order ─────────────────────────────────── */
  const faces = [{ kind: 'cover-front' }, { kind: 'endpaper' }];
  PHOTOS.forEach((p, i) => faces.push({ kind: 'photo', photo: p, folio: i + 1 }));
  faces.push({ kind: 'colophon' });
  if (faces.length % 2 === 0) faces.push({ kind: 'blank' });   // back cover must land on a back face
  faces.push({ kind: 'cover-back' });

  const S     = faces.length / 2;      // number of sheets
  const TOP_Z = (S + 2) * T;           // height of a sheet in flight

  function faceHTML(f, side) {
    const cls = 'face ' + side;
    const fx  = '<div class="cast"></div><div class="shade"></div>';
    switch (f.kind) {
      case 'cover-front':
        return `<div class="${cls} cover cover-front">
          <div class="cover-frame"></div>
          <div class="cover-title">
            <span class="cover-name foil">Alex Li</span>
            <span class="cover-rule"></span>
            <span class="cover-sub foil">photographs</span>
          </div>
          <span class="cover-vol foil">vol. i</span>
          <div class="sheen"></div>${fx}</div>`;
      case 'cover-back':
        return `<div class="${cls} cover cover-back">
          <div class="cover-frame"></div>
          <div class="cover-mark">
            <i class="fa-solid fa-camera foil"></i>
            <span class="cover-sig foil">Alex Li</span>
          </div>
          <div class="sheen"></div>${fx}</div>`;
      case 'endpaper':
        return `<div class="${cls} page endpaper">
          <div class="page-text">
            <p class="ep-title">photographs</p>
            <span class="ep-rule"></span>
            <p class="ep-note">a few places i've been lucky enough to see.</p>
            <p class="ep-meta">shot on sony α6700 · iphone</p>
          </div>${fx}</div>`;
      case 'colophon':
        return `<div class="${cls} page colophon">
          <div class="page-text">
            <p class="ep-title">more to come</p>
            <span class="ep-rule"></span>
            <p class="ep-note">more pages coming soon.<br>thanks for flipping through :)</p>
          </div>${fx}</div>`;
      case 'blank':
        return `<div class="${cls} page">${fx}</div>`;
      case 'photo': {
        const p = f.photo;
        return `<div class="${cls} page">
          <figure class="plate">
            <img data-src="${esc(p.src)}" alt="${esc(p.alt || '')}" draggable="false">
            <figcaption>${esc(p.caption || '')}</figcaption>
          </figure>
          <span class="folio">${f.folio}</span>${fx}</div>`;
      }
    }
    return '';
  }

  /* ── Build DOM ─────────────────────────────────────────────────────── */
  const shadow = document.createElement('div'); shadow.className = 'book-shadow';
  const stackLeft  = document.createElement('div'); stackLeft.className  = 'stack stack-left';
  const stackRight = document.createElement('div'); stackRight.className = 'stack stack-right';
  book.append(shadow, stackLeft, stackRight);

  const sheets = [];
  for (let i = 0; i < S; i++) {
    const el = document.createElement('div');
    el.className = 'sheet' + (i === 0 || i === S - 1 ? ' cover-sheet' : '');
    el.dataset.i = i;
    el.innerHTML = faceHTML(faces[2 * i], 'front') + faceHTML(faces[2 * i + 1], 'back');
    book.appendChild(el);
    const front = el.children[0], back = el.children[1];
    sheets.push({
      i, el, front, back,
      a: 0, tween: null,
      fShade: front.querySelector('.shade'), bShade: back.querySelector('.shade'),
      fCast:  front.querySelector('.cast'),  bCast:  back.querySelector('.cast'),
    });
  }

  /* ── State ─────────────────────────────────────────────────────────── */
  let cur = 0;                 // sheets turned over to the left
  let side = 'right';          // phone mode: which page of the spread is in view
  let single = singleMQ.matches;
  let lock = 0;                // flips in progress
  let interacted = false;
  let hover = null;
  let drag = null;
  const queue = [];

  const restA = i => (i < cur ? 180 : 0);
  const restZ = i => (i < cur ? (i + 1) * T : (S - i) * T);

  function stackShadow(n, dir) {
    const k = Math.min(9, Math.round(n * 0.9));
    const parts = [];
    for (let j = 1; j <= k; j++) {
      parts.push(`${(j * 0.6 * dir).toFixed(1)}px ${j}px 0 ${j % 2 ? '#e6e1d6' : '#cfc9bc'}`);
    }
    return parts.length ? parts.join(',') : 'none';
  }

  function applyState() {
    shift.dataset.state = cur === 0 ? 'closed-front' : cur === S ? 'closed-back' : 'open';
    shift.dataset.side  = side;

    let label = '';
    if (cur === 0) label = 'cover';
    else if (cur === S) label = 'the end';
    else {
      const lf = faces[2 * cur - 1].folio, rf = faces[2 * cur].folio;
      if (single) label = side === 'left' ? (lf ? 'p. ' + lf : '') : (rf ? 'p. ' + rf : '');
      else label = lf && rf ? `p. ${lf}–${rf}` : lf ? 'p. ' + lf : rf ? 'p. ' + rf : '';
    }
    counter.textContent = label;
    btnPrev.disabled = cur === 0 && (!single || side === 'right');
    btnNext.disabled = cur === S && (!single || side === 'left');

    // page-block edges: count only sheets lying flat on each side
    const settled = s => s.i > 0 && s.i < S - 1 && !s.tween && !(drag && drag.i === s.i);
    stackRight.style.boxShadow = stackShadow(sheets.filter(s => settled(s) && s.a < 0.5).length, 1);
    stackLeft.style.boxShadow  = stackShadow(sheets.filter(s => settled(s) && s.a > 179.5).length, -1);

    sheets.forEach(s => {
      const keep = s.i === 0 || s.i === S - 1 || Math.abs(s.i - cur) <= 2 || s.tween || (drag && drag.i === s.i);
      s.el.classList.toggle('dormant', !keep);
    });
    loadNear();
  }

  /* ── Rendering ─────────────────────────────────────────────────────── */
  function render(s) {
    const rest = restA(s.i);
    const z = Math.abs(s.a - rest) < 0.001 ? restZ(s.i) : TOP_Z;
    s.el.style.transform = `translateZ(${z}px) rotateY(${(-s.a).toFixed(3)}deg)`;

    const sn = Math.sin(s.a * Math.PI / 180);
    s.fShade.style.opacity = s.a < 90 ? sn.toFixed(3) : '0';
    s.bShade.style.opacity = s.a > 90 ? sn.toFixed(3) : '0';

    const right = sheets[s.i + 1], left = sheets[s.i - 1];
    if (right) right.fCast.style.opacity = clamp(sn * (1 - s.a / 180) * 1.6, 0, 1).toFixed(3);
    if (left)  left.bCast.style.opacity  = clamp(sn * (s.a / 180) * 1.6, 0, 1).toFixed(3);
  }

  /* ── Flipping ──────────────────────────────────────────────────────── */
  function startTween(s, to, ease) {
    const from = s.a;
    const dur = reduce ? 260 : clamp(1000 * Math.abs(to - from) / 180, 280, 1000);
    s.tween = { from, to, t0: performance.now(), dur, ease };
    lock++;
  }
  function finishTween(s) {
    s.a = s.tween.to;
    s.tween = null;
    lock--;
    render(s);
    applyState();
    if (queue.length && !lock) queue.shift()();
  }

  function flipForward() {
    if (cur >= S) return;
    const s = sheets[cur];
    cur++; side = 'left';
    applyState();
    startTween(s, 180, easeInOut);
  }
  function flipBack() {
    if (cur <= 0) return;
    const s = sheets[cur - 1];
    cur--; side = 'right';
    applyState();
    startTween(s, 0, easeInOut);
  }

  function next() {
    interacted = true;
    if (lock) { if (queue.length < 2) queue.push(next); return; }
    if (single && side === 'left' && cur > 0 && cur < S) { side = 'right'; applyState(); return; }
    flipForward();
  }
  function prev() {
    interacted = true;
    if (lock) { if (queue.length < 2) queue.push(prev); return; }
    if (single && side === 'right' && cur > 0 && cur < S) { side = 'left'; applyState(); return; }
    flipBack();
  }

  /* ── Pointer: click, drag a page, swipe on phones ──────────────────── */
  book.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const el = e.target.closest('.sheet');
    if (!el) return;
    const i = +el.dataset.i;

    if (single) {
      drag = { i, swipe: true, x0: e.clientX, y0: e.clientY, moved: false };
      el.setPointerCapture(e.pointerId);
      return;
    }
    if (lock) return;
    const dir = i === cur ? 1 : i === cur - 1 ? -1 : 0;
    if (!dir) return;

    interacted = true;
    hover = null;
    drag = { i, dir, x0: e.clientX, y0: e.clientY, moved: false, samples: [] };
    el.setPointerCapture(e.pointerId);
    book.classList.add('dragging');
    e.preventDefault();
  });

  book.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < 6) return;
      drag.moved = true;
    }
    if (drag.swipe) return;

    const r = book.getBoundingClientRect();
    const half = r.width / 2, hx = r.left + half;
    const c = clamp((e.clientX - hx) / half, -1, 1);
    sheets[drag.i].a = Math.acos(c) * 180 / Math.PI;   // free edge follows the pointer
    drag.samples.push({ x: e.clientX, t: performance.now() });
    if (drag.samples.length > 6) drag.samples.shift();
  });

  function endDrag(e, cancelled) {
    if (!drag) return;
    const d = drag; drag = null;
    book.classList.remove('dragging');

    if (d.swipe) {
      if (cancelled) return;
      const dx = e.clientX - d.x0;
      if (!d.moved) next();
      else if (dx < -40) next();
      else if (dx > 40) prev();
      return;
    }

    const s = sheets[d.i];
    if (!d.moved) { d.dir === 1 ? flipForward() : flipBack(); return; }

    let v = 0;
    if (d.samples.length >= 2) {
      const a = d.samples[0], b = d.samples[d.samples.length - 1];
      v = (b.x - a.x) / Math.max(1, b.t - a.t);          // px per ms, negative = leftward
    }
    let to;
    if (!cancelled && Math.abs(v) > 0.35) to = v < 0 ? 180 : 0;
    else to = s.a > 90 ? 180 : 0;

    if (d.dir === 1  && to === 180) { cur++; side = 'left'; }
    if (d.dir === -1 && to === 0)   { cur--; side = 'right'; }
    applyState();
    startTween(s, to, easeOut);
  }
  book.addEventListener('pointerup', e => endDrag(e, false));
  book.addEventListener('pointercancel', e => endDrag(e, true));

  // hover: the page you're about to turn lifts a touch
  book.addEventListener('pointerover', e => {
    if (coarse || single || drag || reduce) return;
    const el = e.target.closest('.sheet');
    if (!el) return;
    const i = +el.dataset.i;
    if (i === cur || i === cur - 1) hover = i;
    else if (!((i === cur + 1 && hover === cur) || (i === cur - 2 && hover === cur - 1))) hover = null;
  });
  book.addEventListener('pointerleave', () => { hover = null; });

  btnNext.addEventListener('click', next);
  btnPrev.addEventListener('click', prev);
  addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { next(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { prev(); e.preventDefault(); }
  });

  /* ── Tilt with the mouse, like holding the book ────────────────────── */
  let rx = BASE_X, ry = 0, trx = BASE_X, tryy = 0, sheen = 50, tsheen = 50;
  const tilting = !reduce && !coarse;
  if (tilting) {
    addEventListener('mousemove', e => {
      const nx = e.clientX / innerWidth * 2 - 1;
      const ny = e.clientY / innerHeight * 2 - 1;
      trx = BASE_X - ny * 2.5;
      tryy = nx * 4;
      tsheen = 50 + nx * 45;
    });
  }
  book.style.transform = `rotateX(${BASE_X}deg)`;

  /* ── Images: nearby pages first, then the rest quietly ─────────────── */
  function loadSheet(s) {
    s.el.querySelectorAll('img[data-src]').forEach(img => {
      img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
      img.src = img.dataset.src;
      img.removeAttribute('data-src');
    });
  }
  function loadNear() {
    sheets.forEach(s => { if (Math.abs(s.i - cur) <= 2) loadSheet(s); });
  }
  addEventListener('load', () => {
    let i = 0;
    (function step() {
      while (i < S && !sheets[i].el.querySelector('img[data-src]')) i++;
      if (i >= S) return;
      loadSheet(sheets[i]);
      setTimeout(step, 250);
    })();
  });

  /* ── Sizing ────────────────────────────────────────────────────────── */
  function measure() {
    scene.style.setProperty('--pw', (book.clientWidth / 2) + 'px');
  }
  addEventListener('resize', measure);
  singleMQ.addEventListener('change', () => {
    single = singleMQ.matches;
    side = cur === S ? 'left' : 'right';
    applyState();
  });

  /* ── Frame loop ────────────────────────────────────────────────────── */
  function frame(now) {
    requestAnimationFrame(frame);

    if (tilting) {
      const nrx = rx + (trx - rx) * 0.08, nry = ry + (tryy - ry) * 0.08, ns = sheen + (tsheen - sheen) * 0.08;
      if (Math.abs(nrx - rx) > 1e-3 || Math.abs(nry - ry) > 1e-3) {
        rx = nrx; ry = nry;
        book.style.transform = `rotateX(${rx.toFixed(3)}deg) rotateY(${ry.toFixed(3)}deg)`;
      }
      if (Math.abs(ns - sheen) > 1e-2) {
        sheen = ns;
        scene.style.setProperty('--sheen', sheen.toFixed(2) + '%');
      }
    }

    for (const s of sheets) {
      let a = s.a;
      if (s.tween) {
        const tw = s.tween;
        const t = clamp((now - tw.t0) / tw.dur, 0, 1);
        a = tw.from + (tw.to - tw.from) * tw.ease(t);
        if (t >= 1) { finishTween(s); continue; }
      } else if (drag && drag.i === s.i) {
        // angle already set by pointermove
      } else {
        let target = restA(s.i);
        if (!single && !reduce && !lock) {
          if (hover === s.i) target = s.i === cur ? 5 : 175;
          else if (s.i === 0 && cur === 0 && !interacted) target = 2 - 2 * Math.cos(now / 650);
        }
        if (Math.abs(target - a) > 0.02) a += (target - a) * 0.12;
        else a = target;
      }
      if (a !== s.a) { s.a = a; render(s); }
    }
  }

  measure();
  sheets.forEach(render);
  applyState();
  requestAnimationFrame(frame);

  function goTo(n) {
    if (lock || drag) return;
    cur = clamp(Math.round(n), 0, S);
    side = cur === S ? 'left' : 'right';
    interacted = true;
    sheets.forEach(s => { s.a = restA(s.i); render(s); });
    applyState();
  }

  window.alexBook = { next, prev, goTo, get page() { return cur; }, get pages() { return S; } };
})();
