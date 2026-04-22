(function () {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:-1;';
  document.body.prepend(canvas);

  const ctx = canvas.getContext('2d');

  function resize() { canvas.width = innerWidth; canvas.height = innerHeight; }
  resize();
  addEventListener('resize', resize);

  // Smooth mouse tracking for parallax
  let tmx = 0, tmy = 0, smx = 0, smy = 0;
  addEventListener('mousemove', e => {
    tmx = e.clientX / innerWidth  - 0.5;
    tmy = e.clientY / innerHeight - 0.5;
  });

  const LEAF_COLORS = ['#5a9e4a', '#6ab04c', '#4a8a3a', '#7dc46a', '#8fbc5a'];
  const MAX = 10;
  const MIN = 1;
  const particles = [];

  function rand(a, b) { return a + Math.random() * (b - a); }

  function spawn(spreadY) {
    const isLeaf = Math.random() < 0.6;
    return {
      x: rand(0, innerWidth),
      y: spreadY !== undefined ? rand(-20, spreadY) : -20,
      vx: rand(-0.4, 0.4),
      vy: rand(0.6, 1.4),
      angle: rand(0, Math.PI * 2),
      spin: rand(-0.025, 0.025),
      size: isLeaf ? rand(10, 18) : rand(8, 14),
      type: isLeaf ? 'leaf' : 'blossom',
      sway: rand(0.3, 0.9),
      phase: rand(0, Math.PI * 2),
      opacity: rand(0.55, 0.85),
      color: isLeaf ? LEAF_COLORS[Math.floor(Math.random() * LEAF_COLORS.length)] : null,
      depth: rand(0.4, 1.6),
      t: 0,
    };
  }

  for (let i = 0; i < MAX; i++) particles.push(spawn(innerHeight));

  function drawLeaf(size, color) {
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.bezierCurveTo(size * 0.8, -size * 0.5, size * 0.8, size * 0.5, 0, size);
    ctx.bezierCurveTo(-size * 0.8, size * 0.5, -size * 0.8, -size * 0.5, 0, -size);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(0, size);
    ctx.strokeStyle = 'rgba(0,0,0,0.1)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  function blossomPetal(r) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo( r * 0.5,  -r * 0.15,  r * 0.48, -r * 0.82,  r * 0.16, -r * 0.88);
    ctx.quadraticCurveTo( r * 0.06, -r * 0.98, 0, -r * 0.86);
    ctx.quadraticCurveTo(-r * 0.06, -r * 0.98, -r * 0.16, -r * 0.88);
    ctx.bezierCurveTo(-r * 0.48, -r * 0.82, -r * 0.5, -r * 0.15, 0, 0);
  }

  function drawBlossom(size) {
    for (let i = 0; i < 5; i++) {
      ctx.save();
      ctx.rotate((i / 5) * Math.PI * 2);
      blossomPetal(size);
      ctx.fillStyle = 'rgba(255,183,197,0.93)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(220,140,160,0.3)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.18, 0, Math.PI * 2);
    ctx.fillStyle = '#ffe0ea';
    ctx.fill();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const d = size * 0.32;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * d, Math.sin(a) * d, size * 0.055, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(210,100,130,0.7)';
      ctx.fill();
    }
  }

  let prev = 0;

  function frame(now) {
    const dt = Math.min((now - prev) / 16.67, 3);
    prev = now;

    smx += (tmx - smx) * 0.04 * dt;
    smy += (tmy - smy) * 0.04 * dt;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (document.documentElement.dataset.theme === 'dark') {
      requestAnimationFrame(frame);
      return;
    }

    let onScreen = 0;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.t += dt;
      p.x += (p.vx + Math.sin(p.phase + p.t * 0.018) * p.sway) * dt;
      p.y += p.vy * dt;
      p.angle += p.spin * dt;

      if (p.y > canvas.height + 40) { particles.splice(i, 1); continue; }
      onScreen++;

      ctx.save();
      ctx.translate(p.x + smx * p.depth * 22, p.y + smy * p.depth * 12);
      ctx.rotate(p.angle);
      ctx.globalAlpha = p.opacity;
      if (p.type === 'leaf') drawLeaf(p.size, p.color);
      else drawBlossom(p.size);
      ctx.restore();
    }

    if (onScreen < MIN || (particles.length < MAX && Math.random() < 0.006 * dt)) {
      particles.push(spawn());
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
