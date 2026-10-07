(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const emptyState = $('emptyState');
  const status = $('status');
  const calibrationInfo = $('calibrationInfo');

  const state = {
    img: null,
    imgUrl: null,
    mode: null,
    floorPts: [],
    verticalPts: [],
    H: null,
    Hinv: null,
    vz: null,
    lambdaZ: null,
    tentOrigin: null,
    calibrated: false
  };

  const pointColors = {
    floor: '#22c55e',
    vertical: '#f59e0b',
    place: '#38bdf8'
  };

  function setStatus(msg) {
    status.textContent = msg;
  }

  function num(id, fallback = 0) {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? v : fallback;
  }

  function clearCalibration() {
    state.H = null;
    state.Hinv = null;
    state.vz = null;
    state.lambdaZ = null;
    state.calibrated = false;
    state.tentOrigin = null;
    calibrationInfo.textContent = 'Aún sin calibrar.';
  }

  function resetAll(keepImage = false) {
    state.mode = null;
    state.floorPts = [];
    state.verticalPts = [];
    clearCalibration();
    if (!keepImage) {
      state.img = null;
      if (state.imgUrl) URL.revokeObjectURL(state.imgUrl);
      state.imgUrl = null;
      emptyState.style.display = 'block';
      canvas.width = 1;
      canvas.height = 1;
    }
    redraw();
    setStatus(keepImage ? 'Foto conservada. Vuelve a marcar las referencias.' : 'Carga una fotografía para empezar.');
  }

  function loadImage(file) {
    if (!file) return;
    if (state.imgUrl) URL.revokeObjectURL(state.imgUrl);
    state.imgUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const maxDim = 2400;
      const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      state.img = img;
      state.floorPts = [];
      state.verticalPts = [];
      clearCalibration();
      emptyState.style.display = 'none';
      redraw();
      setStatus('Foto cargada. Ahora marca las 4 esquinas del plano del piso.');
      state.mode = 'floor';
    };
    img.onerror = () => setStatus('No pude abrir esa imagen. Prueba con JPG o PNG.');
    img.src = state.imgUrl;
  }

  function pointerToCanvas(ev) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left) * canvas.width / r.width,
      y: (ev.clientY - r.top) * canvas.height / r.height
    };
  }

  function drawImageBase() {
    if (!state.img) {
      ctx.fillStyle = '#030712';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    ctx.drawImage(state.img, 0, 0, canvas.width, canvas.height);
  }

  function drawDot(p, color, label) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(6, canvas.width / 380), 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = Math.max(2, canvas.width / 900);
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.font = `${Math.max(16, canvas.width / 95)}px system-ui`;
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000';
    ctx.strokeText(label, p.x + 10, p.y - 10);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, p.x + 10, p.y - 10);
    ctx.restore();
  }

  function drawPolyline(points, color, close = false, dash = []) {
    if (points.length < 2) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    if (close) ctx.closePath();
    ctx.lineWidth = Math.max(2.5, canvas.width / 800);
    ctx.strokeStyle = color;
    ctx.setLineDash(dash);
    ctx.stroke();
    ctx.restore();
  }

  function lineHomogeneous(a, b) {
    return [
      a.y - b.y,
      b.x - a.x,
      a.x * b.y - a.y * b.x
    ];
  }

  function cross3(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }

  function solveLinear(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.slice().concat([b[i]]));
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
      }
      if (Math.abs(M[pivot][col]) < 1e-12) throw new Error('Sistema geométrico degenerado.');
      [M[col], M[pivot]] = [M[pivot], M[col]];
      const div = M[col][col];
      for (let c = col; c <= n; c++) M[col][c] /= div;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col];
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    return M.map(row => row[n]);
  }

  function homographyFrom4(worldPts, imagePts) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const X = worldPts[i][0], Y = worldPts[i][1];
      const u = imagePts[i].x, v = imagePts[i].y;
      A.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y]);
      b.push(u);
      A.push([0, 0, 0, X, Y, 1, -v * X, -v * Y]);
      b.push(v);
    }
    const h = solveLinear(A, b);
    return [
      [h[0], h[1], h[2]],
      [h[3], h[4], h[5]],
      [h[6], h[7], 1]
    ];
  }

  function det3(m) {
    return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
      - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
      + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  }

  function invert3(m) {
    const d = det3(m);
    if (Math.abs(d) < 1e-12) throw new Error('No se puede invertir el plano.');
    return [
      [
        (m[1][1] * m[2][2] - m[1][2] * m[2][1]) / d,
        (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / d,
        (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / d
      ],
      [
        (m[1][2] * m[2][0] - m[1][0] * m[2][2]) / d,
        (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / d,
        (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / d
      ],
      [
        (m[1][0] * m[2][1] - m[1][1] * m[2][0]) / d,
        (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / d,
        (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / d
      ]
    ];
  }

  function mulMatVec(m, v) {
    return m.map(row => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  }

  function normalizeHomogeneous(v) {
    if (Math.abs(v[2]) > 1e-10) return [v[0] / v[2], v[1] / v[2], 1];
    const n = Math.hypot(v[0], v[1]) || 1;
    return [v[0] / n, v[1] / n, 0];
  }

  function imageToGround(p) {
    if (!state.Hinv) return null;
    const q = mulMatVec(state.Hinv, [p.x, p.y, 1]);
    if (Math.abs(q[2]) < 1e-12) return null;
    return { x: q[0] / q[2], y: q[1] / q[2] };
  }

  function solveVerticalScale(H, vz, baseImage, topImage, realHeight) {
    const inv = invert3(H);
    const q = mulMatVec(inv, [baseImage.x, baseImage.y, 1]);
    if (Math.abs(q[2]) < 1e-12) throw new Error('La base de la vertical no cae sobre el plano.');
    const ground = [q[0] / q[2], q[1] / q[2]];

    const b = mulMatVec(H, [ground[0], ground[1], 1]);
    const t = [topImage.x, topImage.y, 1];

    let aa = 0, ab = 0, bb = 0, ra = 0, rb = 0;
    for (let i = 0; i < 3; i++) {
      const A0 = vz[i];
      const A1 = -t[i];
      const rhs = -b[i];
      aa += A0 * A0;
      ab += A0 * A1;
      bb += A1 * A1;
      ra += A0 * rhs;
      rb += A1 * rhs;
    }
    const det = aa * bb - ab * ab;
    if (Math.abs(det) < 1e-14) throw new Error('La vertical de referencia no es suficiente.');
    const a = (ra * bb - rb * ab) / det;
    const lambda = a / realHeight;
    if (!Number.isFinite(lambda) || Math.abs(lambda) < 1e-14) throw new Error('No pude obtener la escala vertical.');
    return lambda;
  }

  function calibrate() {
    try {
      if (state.floorPts.length !== 4) throw new Error('Faltan las 4 esquinas del piso.');
      if (state.verticalPts.length !== 4) throw new Error('Faltan las dos verticales.');
      const W = num('floorW', 0), D = num('floorD', 0), refH = num('refHeight', 0);
      if (!(W > 0 && D > 0 && refH > 0)) throw new Error('Las medidas reales deben ser mayores que cero.');

      const world = [[0, 0], [W, 0], [W, D], [0, D]];
      const H = homographyFrom4(world, state.floorPts);
      const Hinv = invert3(H);

      const [b1, t1, b2, t2] = state.verticalPts;
      const l1 = lineHomogeneous(b1, t1);
      const l2 = lineHomogeneous(b2, t2);
      let vz = cross3(l1, l2);
      if (Math.hypot(vz[0], vz[1], vz[2]) < 1e-9) throw new Error('Las verticales no permiten hallar su punto de fuga.');
      vz = normalizeHomogeneous(vz);

      const lambdaZ = solveVerticalScale(H, vz, b1, t1, refH);

      state.H = H;
      state.Hinv = Hinv;
      state.vz = vz;
      state.lambdaZ = lambdaZ;
      state.calibrated = true;
      state.mode = 'place';

      const g1 = imageToGround(b1);
      const g2 = imageToGround(b2);
      const sep = g1 && g2 ? Math.hypot(g2.x - g1.x, g2.y - g1.y) : 0;
      calibrationInfo.textContent = `Calibración lista. Plano ${W.toFixed(2)} × ${D.toFixed(2)} m. Referencias verticales separadas aprox. ${sep.toFixed(2)} m sobre el plano.`;
      setStatus('Perspectiva calculada. Toca el piso para colocar la carpa.');
      redraw();
    } catch (err) {
      state.calibrated = false;
      calibrationInfo.textContent = `Error: ${err.message}`;
      setStatus(err.message);
      redraw();
    }
  }

  function project3D(X, Y, Z) {
    if (!state.H) return null;
    const q0 = mulMatVec(state.H, [X, Y, 1]);
    const q = [
      q0[0] + state.lambdaZ * Z * state.vz[0],
      q0[1] + state.lambdaZ * Z * state.vz[1],
      q0[2] + state.lambdaZ * Z * state.vz[2]
    ];
    if (Math.abs(q[2]) < 1e-12) return null;
    return { x: q[0] / q[2], y: q[1] / q[2] };
  }

  function drawGroundGrid() {
    if (!state.calibrated) return;
    const W = num('floorW', 0), D = num('floorD', 0);
    const step = Math.max(0.1, num('gridStep', 1));
    const color = 'rgba(56,189,248,.65)';
    for (let x = 0; x <= W + 1e-9; x += step) {
      const xx = Math.min(x, W);
      const a = project3D(xx, 0, 0);
      const b = project3D(xx, D, 0);
      if (a && b) drawPolyline([a, b], color, false, [10, 10]);
    }
    for (let y = 0; y <= D + 1e-9; y += step) {
      const yy = Math.min(y, D);
      const a = project3D(0, yy, 0);
      const b = project3D(W, yy, 0);
      if (a && b) drawPolyline([a, b], color, false, [10, 10]);
    }
    const border = [
      project3D(0, 0, 0), project3D(W, 0, 0),
      project3D(W, D, 0), project3D(0, D, 0)
    ];
    if (border.every(Boolean)) drawPolyline(border, '#38bdf8', true);
  }

  function rotateLocal(x, y, angleRad) {
    const c = Math.cos(angleRad), s = Math.sin(angleRad);
    return { x: x * c - y * s, y: x * s + y * c };
  }

  function tentWorldVertices() {
    if (!state.tentOrigin || !state.calibrated) return null;
    const w = Math.max(0.1, num('tentW', 10));
    const d = Math.max(0.1, num('tentD', 6));
    const h = Math.max(0.1, num('tentH', 3));
    const ridge = Math.max(h, num('tentRidge', 4.2));
    const ang = num('tentAngle', 0) * Math.PI / 180;
    const o = state.tentOrigin;

    function P(x, y, z) {
      const r = rotateLocal(x, y, ang);
      return { X: o.x + r.x, Y: o.y + r.y, Z: z };
    }

    return {
      A: P(-w / 2, -d / 2, 0),
      B: P(w / 2, -d / 2, 0),
      C: P(w / 2, d / 2, 0),
      D: P(-w / 2, d / 2, 0),
      At: P(-w / 2, -d / 2, h),
      Bt: P(w / 2, -d / 2, h),
      Ct: P(w / 2, d / 2, h),
      Dt: P(-w / 2, d / 2, h),
      Rf: P(0, -d / 2, ridge),
      Rb: P(0, d / 2, ridge)
    };
  }

  function drawTent() {
    const V = tentWorldVertices();
    if (!V) return;
    const P = {};
    for (const [k, v] of Object.entries(V)) P[k] = project3D(v.X, v.Y, v.Z);

    const footprint = [P.A, P.B, P.C, P.D];
    if (footprint.every(Boolean)) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(footprint[0].x, footprint[0].y);
      for (let i = 1; i < footprint.length; i++) ctx.lineTo(footprint[i].x, footprint[i].y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(34,197,94,.12)';
      ctx.fill();
      ctx.restore();
      drawPolyline(footprint, '#22c55e', true);
    }

    const edges = [
      ['A','At'], ['B','Bt'], ['C','Ct'], ['D','Dt'],
      ['At','Bt'], ['Bt','Ct'], ['Ct','Dt'], ['Dt','At'],
      ['At','Rf'], ['Bt','Rf'], ['Dt','Rb'], ['Ct','Rb'], ['Rf','Rb']
    ];
    for (const [a, b] of edges) {
      if (P[a] && P[b]) drawPolyline([P[a], P[b]], '#f8fafc');
    }
    if (P.Rf && P.Rb) drawPolyline([P.Rf, P.Rb], '#f59e0b');
  }

  function drawReferences() {
    if (state.floorPts.length) {
      drawPolyline(state.floorPts, pointColors.floor, state.floorPts.length === 4);
      state.floorPts.forEach((p, i) => drawDot(p, pointColors.floor, `P${i + 1}`));
    }
    if (state.verticalPts.length) {
      if (state.verticalPts.length >= 2) drawPolyline(state.verticalPts.slice(0, 2), pointColors.vertical);
      if (state.verticalPts.length >= 4) drawPolyline(state.verticalPts.slice(2, 4), pointColors.vertical);
      const labels = ['B1', 'T1', 'B2', 'T2'];
      state.verticalPts.forEach((p, i) => drawDot(p, pointColors.vertical, labels[i]));
    }
  }

  function redraw() {
    drawImageBase();
    if (!state.img) return;
    if (state.calibrated) drawGroundGrid();
    drawTent();
    drawReferences();
  }

  function setMode(mode) {
    if (!state.img) {
      setStatus('Primero carga una foto.');
      return;
    }
    state.mode = mode;
    if (mode === 'floor') {
      state.floorPts = [];
      clearCalibration();
      setStatus('Marca 4 esquinas del piso: frente-izq, frente-der, fondo-der, fondo-izq.');
    } else if (mode === 'vertical') {
      state.verticalPts = [];
      clearCalibration();
      setStatus('Marca base y punta del poste 1; luego base y punta del poste 2.');
    } else if (mode === 'place') {
      if (!state.calibrated) {
        setStatus('Primero calcula la perspectiva.');
        return;
      }
      setStatus('Toca un punto del piso para ubicar el centro de la carpa.');
    }
    redraw();
  }

  function undo() {
    if (state.mode === 'floor' && state.floorPts.length) {
      state.floorPts.pop();
      clearCalibration();
    } else if (state.mode === 'vertical' && state.verticalPts.length) {
      state.verticalPts.pop();
      clearCalibration();
    } else if (state.tentOrigin) {
      state.tentOrigin = null;
    } else if (state.verticalPts.length) {
      state.verticalPts.pop();
      clearCalibration();
    } else if (state.floorPts.length) {
      state.floorPts.pop();
      clearCalibration();
    }
    redraw();
  }

  function exportImage() {
    if (!state.img) {
      setStatus('No hay imagen para exportar.');
      return;
    }
    redraw();
    try {
      const link = document.createElement('a');
      link.download = `perspectiva-${Date.now()}.jpg`;
      link.href = canvas.toDataURL('image/jpeg', 0.94);
      link.click();
      setStatus('Imagen exportada.');
    } catch {
      setStatus('No pude exportar la imagen en este dispositivo.');
    }
  }

  canvas.addEventListener('pointerdown', ev => {
    if (!state.img) return;
    const p = pointerToCanvas(ev);

    if (state.mode === 'floor') {
      if (state.floorPts.length < 4) {
        state.floorPts.push(p);
        if (state.floorPts.length === 4) {
          state.mode = 'vertical';
          setStatus('Piso marcado. Ahora marca base y punta de dos postes verticales.');
        } else {
          setStatus(`Piso: ${state.floorPts.length}/4 puntos.`);
        }
      }
    } else if (state.mode === 'vertical') {
      if (state.verticalPts.length < 4) {
        state.verticalPts.push(p);
        if (state.verticalPts.length === 4) {
          state.mode = null;
          setStatus('Verticales listas. Pulsa “Calcular perspectiva”.');
        } else {
          setStatus(`Verticales: ${state.verticalPts.length}/4 puntos.`);
        }
      }
    } else if (state.mode === 'place') {
      const g = imageToGround(p);
      if (g) {
        state.tentOrigin = g;
        setStatus(`Carpa colocada en X=${g.x.toFixed(2)} m, Y=${g.y.toFixed(2)} m.`);
      }
    }
    redraw();
  });

  ['floorW','floorD','refHeight','tentW','tentD','tentH','tentRidge','tentAngle','gridStep'].forEach(id => {
    $(id).addEventListener('input', () => {
      if (['floorW','floorD','refHeight'].includes(id)) clearCalibration();
      redraw();
    });
  });

  $('photoBtn').addEventListener('click', () => $('photoInput').click());
  $('photoInput').addEventListener('change', e => loadImage(e.target.files?.[0]));
  $('floorModeBtn').addEventListener('click', () => setMode('floor'));
  $('verticalModeBtn').addEventListener('click', () => setMode('vertical'));
  $('calibrateBtn').addEventListener('click', calibrate);
  $('placeModeBtn').addEventListener('click', () => setMode('place'));
  $('undoBtn').addEventListener('click', undo);
  $('clearTentBtn').addEventListener('click', () => {
    state.tentOrigin = null;
    redraw();
    setStatus('Carpa retirada.');
  });
  $('resetBtn').addEventListener('click', () => resetAll(true));
  const exportBtn = $('exportBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportImage);

  redraw();

})();
