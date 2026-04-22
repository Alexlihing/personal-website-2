(function () {
  'use strict';

  const canvas = document.getElementById('sphere-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = 140, H = 100;

  // Internal resolution (sharp on retina); CSS controls display size
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  // ── Palette (matches site) ─────────────────────────────────────
  const C_FIG   = '#1a1a1a';
  const C_BALL  = '#d4631e';
  const C_SEAM  = 'rgba(0,0,0,0.20)';
  const C_RIM   = '#b84c1e';
  const C_POST  = '#aaa';
  const C_NET   = '#c0bfb8';
  const C_FLOOR = '#dddcd6';

  const LOOP_MS = 2800; // one full cycle

  // ── Math helpers ───────────────────────────────────────────────
  const lerp  = (a, b, t) => a + (b - a) * t;
  const lerpV = ([ax, ay], [bx, by], t) => [lerp(ax, bx, t), lerp(ay, by, t)];
  const ease  = t => t < .5 ? 2*t*t : -1 + (4 - 2*t)*t;
  const qbez  = ([x0,y0],[cx,cy],[x2,y2], s) => {
    const u = 1 - s;
    return [u*u*x0 + 2*u*s*cx + s*s*x2,
            u*u*y0 + 2*u*s*cy + s*s*y2];
  };

  // ── Stick-figure keyframes (CSS pixels, 140 × 100 canvas) ──────
  // Joints: head, neck, hip,
  //         lsh/rsh (shoulders), lelb/relb (elbows), lhnd/rhnd (hands),
  //         lknee/rknee, lfoot/rfoot
  const KF = [
    // t 0.00 — idle, holding ball at waist
    { t: 0.00,
      head:[28,47], neck:[28,55], hip:[28,74],
      lsh:[21,60], rsh:[35,60],  lelb:[17,67], relb:[39,67],  lhnd:[21,74], rhnd:[35,74],
      lknee:[22,84], rknee:[34,84],  lfoot:[18,95], rfoot:[38,95] },

    // t 0.20 — wind-up begins, slight crouch
    { t: 0.20,
      head:[28,50], neck:[28,58], hip:[28,77],
      lsh:[21,63], rsh:[35,63],  lelb:[17,71], relb:[39,71],  lhnd:[21,78], rhnd:[35,78],
      lknee:[21,87], rknee:[35,87],  lfoot:[16,95], rfoot:[40,95] },

    // t 0.37 — deep crouch, ball low
    { t: 0.37,
      head:[28,53], neck:[28,61], hip:[28,80],
      lsh:[20,66], rsh:[36,66],  lelb:[15,74], relb:[41,74],  lhnd:[19,82], rhnd:[37,82],
      lknee:[20,89], rknee:[36,89],  lfoot:[14,95], rfoot:[42,95] },

    // t 0.50 — peak jump, arms fully extended, ball released
    { t: 0.50,
      head:[28,32], neck:[28,40], hip:[28,59],
      lsh:[22,45], rsh:[34,45],  lelb:[21,37], relb:[35,37],  lhnd:[24,28], rhnd:[32,28],
      lknee:[22,69], rknee:[34,69],  lfoot:[19,81], rfoot:[37,81] },

    // t 0.63 — follow-through, wrists extended, still in air
    { t: 0.63,
      head:[28,34], neck:[28,42], hip:[28,61],
      lsh:[21,47], rsh:[35,47],  lelb:[17,40], relb:[42,40],  lhnd:[18,36], rhnd:[39,36],
      lknee:[22,72], rknee:[34,72],  lfoot:[19,84], rfoot:[37,84] },

    // t 0.75 — landing, knees absorbing impact
    { t: 0.75,
      head:[28,45], neck:[28,53], hip:[28,72],
      lsh:[21,58], rsh:[35,58],  lelb:[18,65], relb:[38,65],  lhnd:[20,71], rhnd:[36,71],
      lknee:[22,82], rknee:[34,82],  lfoot:[18,94], rfoot:[38,94] },

    // t 0.86 — standing, watching ball go through
    { t: 0.86,
      head:[28,47], neck:[28,55], hip:[28,74],
      lsh:[21,60], rsh:[35,60],  lelb:[17,67], relb:[39,67],  lhnd:[20,72], rhnd:[36,72],
      lknee:[22,84], rknee:[34,84],  lfoot:[18,95], rfoot:[38,95] },

    // t 1.00 — back to idle (identical to t=0, closes the loop)
    { t: 1.00,
      head:[28,47], neck:[28,55], hip:[28,74],
      lsh:[21,60], rsh:[35,60],  lelb:[17,67], relb:[39,67],  lhnd:[21,74], rhnd:[35,74],
      lknee:[22,84], rknee:[34,84],  lfoot:[18,95], rfoot:[38,95] },
  ];

  const JOINTS = ['head','neck','hip','lsh','rsh','lelb','relb','lhnd','rhnd','lknee','rknee','lfoot','rfoot'];

  function getPose(t) {
    let i = 0;
    while (i < KF.length - 2 && KF[i + 1].t <= t) i++;
    const a = KF[i], b = KF[i + 1];
    const e = ease((t - a.t) / (b.t - a.t));
    const p = {};
    for (const k of JOINTS) p[k] = lerpV(a[k], b[k], e);
    return p;
  }

  // ── Ball trajectory ────────────────────────────────────────────
  // Phases: [0, T_REL) in hands → [T_REL, T_RIM) physics arc to hoop →
  //         [T_RIM, T_GND) falls through net → [T_GND, 1) arcs back to hands
  const T_REL = 0.50; // ball leaves hands (matches KF jump frame)
  const T_RIM = 0.76; // ball passes through rim
  const T_GND = 0.88; // ball reaches the ground below hoop
  const T_RET = 1.00; // ball arrives back in hands

  // Physics constants for the shot arc
  const P_REL = [28, 28];   // release point  (= hands midpoint at t=T_REL)
  const P_RIM = [118, 34];  // rim centre
  const P_GND = [104, 95];  // landing spot after falling through net
  const G     = 90;         // gravity factor (tunes arc height)
  const VY0   = P_RIM[1] - P_REL[1] - G; // = -84 (launches upward)

  function getBallPos(t, pose) {
    if (t < T_REL) {
      // Ball held between hands
      const [lx, ly] = pose.lhnd, [rx, ry] = pose.rhnd;
      return [(lx + rx) / 2, (ly + ry) / 2];
    }
    if (t < T_RIM) {
      // Parabolic arc: x linear, y governed by VY0 + gravity
      const s = (t - T_REL) / (T_RIM - T_REL);
      return [
        lerp(P_REL[0], P_RIM[0], s),
        P_REL[1] + VY0 * s + G * s * s,
      ];
    }
    if (t < T_GND) {
      // Falls through net (quadratic = accelerating)
      const s = (t - T_RIM) / (T_GND - T_RIM);
      return lerpV(P_RIM, P_GND, s * s);
    }
    // Arcs back to idle hands position [28, 74]
    const s = (t - T_GND) / (T_RET - T_GND);
    return qbez(P_GND, [65, 80], [28, 74], ease(s));
  }

  // ── Drawing helpers ────────────────────────────────────────────
  function seg([ax, ay], [bx, by]) {
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }

  function drawHoop(wobble) {
    ctx.lineCap = 'round';

    // Post
    ctx.strokeStyle = C_POST; ctx.lineWidth = 1.5;
    seg([136, 18], [136, 95]);

    // Backboard (thicker stroke on same post line)
    ctx.lineWidth = 3.5;
    seg([136, 17], [136, 53]);

    // Arm from backboard to rim
    ctx.lineWidth = 1.5;
    seg([136, 33], [126, 34]);

    // Rim
    ctx.strokeStyle = C_RIM; ctx.lineWidth = 2.5;
    seg([110, 34], [126, 34]);

    // Net — 5 lines converging toward a loose bottom
    ctx.lineWidth = 0.8; ctx.strokeStyle = C_NET;
    const anchors = [110, 113, 118, 123, 126];
    anchors.forEach((ax, i) => {
      const sign  = i % 2 === 0 ? 1 : -1;
      const botX  = lerp(ax, 118, 0.65) + wobble * sign;
      ctx.beginPath(); ctx.moveTo(ax, 34); ctx.lineTo(botX, 54); ctx.stroke();
    });
    // Two horizontal cross-threads (make it look like mesh)
    ctx.beginPath(); ctx.moveTo(112 + wobble * 0.3, 44); ctx.lineTo(124 + wobble * 0.3, 44); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(113 + wobble * 0.5, 50); ctx.lineTo(123 + wobble * 0.5, 50); ctx.stroke();
  }

  function drawFigure(p) {
    ctx.strokeStyle = C_FIG; ctx.lineWidth = 2; ctx.lineCap = 'round';

    seg(p.lsh,  p.rsh);                               // shoulder bar
    seg(p.neck, p.hip);                               // torso
    seg(p.lsh,  p.lelb); seg(p.lelb, p.lhnd);        // left arm
    seg(p.rsh,  p.relb); seg(p.relb, p.rhnd);        // right arm
    seg(p.hip,  p.lknee); seg(p.lknee, p.lfoot);     // left leg
    seg(p.hip,  p.rknee); seg(p.rknee, p.rfoot);     // right leg

    // Head
    ctx.fillStyle = C_FIG;
    ctx.beginPath(); ctx.arc(p.head[0], p.head[1], 6, 0, Math.PI * 2); ctx.fill();

    // Tiny eye — faces right (toward hoop), gives personality
    ctx.fillStyle = '#fafaf8';
    ctx.beginPath(); ctx.arc(p.head[0] + 3.5, p.head[1] - 1, 1.2, 0, Math.PI * 2); ctx.fill();
  }

  function drawBall([x, y], spin) {
    const r = 5;
    // Body
    ctx.fillStyle = C_BALL;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    // Seams
    ctx.strokeStyle = C_SEAM; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.arc(x, y, r, spin, spin + Math.PI); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, r, spin + Math.PI, spin + 2 * Math.PI); ctx.stroke();
    ctx.save();
    ctx.translate(x, y); ctx.rotate(spin + Math.PI / 2); ctx.scale(0.45, 1);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.strokeStyle = C_SEAM; ctx.stroke();
    ctx.restore();
  }

  // ── Main render loop ───────────────────────────────────────────
  let t0 = null, spin = 0;

  function render(ts) {
    if (!t0) t0 = ts;
    const t = ((ts - t0) % LOOP_MS) / LOOP_MS;

    ctx.clearRect(0, 0, W, H);

    // Floor line
    ctx.strokeStyle = C_FLOOR; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, 95); ctx.lineTo(W, 95); ctx.stroke();

    const pose = getPose(t);
    const ball = getBallPos(t, pose);

    // Net wobble: burst when ball passes the rim
    const dt = t - T_RIM;
    const wobble = (dt > -0.01 && dt < 0.08)
      ? Math.sin((dt + 0.01) / 0.09 * Math.PI)
        * Math.sin((dt + 0.01) / 0.09 * Math.PI * 3)
        * 2.5
      : 0;

    spin += 0.06;

    drawHoop(wobble);
    drawFigure(pose);
    drawBall(ball, spin);

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
})();
