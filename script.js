/* =========================================================
   JGVRP Speedometer HUD - klaster analog 3 dial (RPM · MPH · FUEL/OIL)

   API (dipanggil dari game / CEF) - nama lama dipertahankan:
     setSpeed(m/s)            setRPM(0.0 - 1.0)     <- 1.0 = revLimit
     setFuel(0-1 | 0-100)     setHealth(0-1 | 0-1000)   -> OIL PRESS + lampu CHECK ENGINE
     setGear(n)               setHeadlights(0 off | 1 low | 2 high)
     setSeatbelts(bool)       setEngine(bool)
     updateLockStatus(state)  setOdometer(miles)
   Baru:
     setLimiter(true|false|null)   status limiter dari game (null = deteksi otomatis dari RPM)
     setRevLimit(rpm)              mis. 8000 (atau 8 = x1000)
     setConfig({...})              ubah parameter di CONFIG saat runtime
   Pesan NUI: window.postMessage({ action: 'setRPM', rpm: 0.5 }) dst. (lihat ACTIONS di bawah)
   Override konfigurasi sebelum script ini dimuat: window.HUD_CONFIG = { revLimit: 7500, ... }
   ========================================================= */
(function () {
'use strict';

/* =========================================================
   1. KONFIGURASI  (semua parameter yang sering diubah ada di sini)
   ========================================================= */
const DEFAULTS = {
    // ----- Tachometer (satuan: RPM mentah; 8000 = angka "8" pada dial x1000)
    rpmMin: 0,
    rpmMax: 9000,                 // ujung skala dial
    rpmAngleStart: 140,           // sudut jarum di RPM minimum (derajat SVG: 0 = kanan, searah jarum jam)
    rpmAngleEnd: 400,             // sudut jarum di RPM maksimum
    revLimit: 8000,               // RPM saat setRPM(1.0) = batas putaran (rev limiter)
    redlineStart: 6500,           // awal zona merah pada dial (hanya tampilan, TIDAK memicu getaran)
    redlineEnd: 8300,             // akhir zona merah pada dial
    needleResponse: 18,           // kecepatan jarum mengejar RPM (1/detik; makin besar makin cepat)
    needleSmoothing: 0.3,         // 0 = naik & turun sama cepat, 1 = turun separuh lebih lambat (kesan inersia jarum)
    needleMaxSpeed: 900,          // batas kecepatan sapuan jarum RPM & speed (derajat/detik; 0 = tanpa batas)

    // ----- Rev limiter (needle shake)
    limiterThreshold: 0.975,      // RPM/revLimit >= ini selama limiterHoldTime  -> limiter dianggap aktif
    limiterReleaseThreshold: 0.92,// RPM/revLimit < ini selama limiterReleaseTime -> limiter dilepas (hysteresis)
    limiterHoldTime: 0.10,        // detik RPM harus tertahan di atas threshold sebelum getaran mulai
    limiterReleaseTime: 0.20,     // detik RPM harus di bawah release threshold sebelum getaran berhenti
    limiterAttackTime: 0.04,      // detik getaran naik sampai penuh
    limiterRecoverTime: 0.15,     // detik getaran memudar sampai nol setelah limiter lepas
    limiterShakeAmplitude: 2.0,   // amplitudo maksimum getaran (derajat jarum)
    limiterShakeFrequency: 24,    // frekuensi dasar getaran (Hz)

    // ----- Speedometer
    speedMax: 180,                // mph di ujung skala
    speedAngleStart: 140,
    speedAngleEnd: 400,
    speedResponse: 12,

    // ----- Fuel
    fuelAngleStart: 207,
    fuelAngleEnd: 333,
    fuelLowZone: 0.15,            // lebar zona merah dekat E (0-1)
    fuelResponse: 3,

    // ----- Oil press (diturunkan dari setHealth)
    oilMaxPsi: 80,                // ujung skala PSI
    oilPsiAtFullHealth: 60,       // PSI yang ditunjuk saat health 100% (health 50% -> 30 PSI)
    oilAngleStart: 195,
    oilAngleEnd: 345,
    oilResponse: 5,
    checkEngineHealthBelow: 0.5,  // lampu CHECK ENGINE menyala saat health <= nilai ini (0.5 = 50%)

    // ----- Lain-lain
    dataTimeoutMs: 0,             // >0: kalau setRPM tidak dipanggil selama ini, RPM dianggap 0 (0 = nonaktif)
    maxFps: 60,
};
const CFG = Object.assign({}, DEFAULTS, window.HUD_CONFIG || {});
let FRAME_MS = 1000 / CFG.maxFps;

// Parameter yang mengubah geometri dial -> dial digambar ulang kalau diubah lewat setConfig()
const GEOMETRY_KEYS = ['rpmMin', 'rpmMax', 'rpmAngleStart', 'rpmAngleEnd', 'redlineStart', 'redlineEnd',
    'speedMax', 'speedAngleStart', 'speedAngleEnd', 'fuelAngleStart', 'fuelAngleEnd', 'fuelLowZone',
    'oilMaxPsi', 'oilAngleStart', 'oilAngleEnd'];

/* =========================================================
   2. HELPER
   ========================================================= */
const MPS_TO_MPH = 2.236936;
const NOOP_EL = document.createElement('div');   // pengaman kalau ada elemen yang sudah dihapus dari HTML
const $ = (id) => document.getElementById(id) || NOOP_EL;
const elHud = $('hud');
const svg = $('dial');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v) => clamp(v, 0, 1);
// angka valid atau null (undefined / null / '' / boolean / NaN / Infinity ditolak, bukan dijadikan 0)
const finite = (v) => {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
function isLockedState(val) { return val === true || val === 1 || val === '1' || val === 'true' || val === 2 || val === '2'; }
function isTrueValue(val) { return val === true || val === 1 || val === '1' || val === 'true'; }

function setText(el, txt) { txt = String(txt); if (el.textContent !== txt) el.textContent = txt; }
function setClass(el, cls) { if (el.getAttribute('class') !== cls) el.setAttribute('class', cls); }   // aman utk elemen SVG

/* =========================================================
   3. GEOMETRI & PEMBUATAN DIAL  (satu sistem koordinat: viewBox 1600 x 700)
   ========================================================= */
const G = {
    rpm:   { cx: 275,  cy: 355, rf: 200 },     // tachometer (kiri)
    speed: { cx: 810,  cy: 335, rf: 270 },     // speedometer (tengah)
    side:  { cx: 1343, cy: 355, rf: 200 },     // fuel (atas) + oil press (bawah) (kanan)
};
const FP = { x: G.side.cx - 2, y: G.side.cy - 62 };    // pivot jarum fuel
const OP = { x: G.side.cx,     y: G.side.cy + 118 };   // pivot jarum oil press
const LAMP_Y = 617;

const f2 = (n) => Math.round(n * 100) / 100;
const pt = (cx, cy, r, a) => { const t = (a * Math.PI) / 180; return [f2(cx + r * Math.cos(t)), f2(cy + r * Math.sin(t))]; };
function sector(cx, cy, r1, r2, a1, a2) {
    if (a2 - a1 < 0.05) return '';
    const [x1, y1] = pt(cx, cy, r2, a1), [x2, y2] = pt(cx, cy, r2, a2), [x3, y3] = pt(cx, cy, r1, a2), [x4, y4] = pt(cx, cy, r1, a1);
    const large = a2 - a1 > 180 ? 1 : 0;
    return `M${x1} ${y1}A${r2} ${r2} 0 ${large} 1 ${x2} ${y2}L${x3} ${y3}A${r1} ${r1} 0 ${large} 0 ${x4} ${y4}Z`;
}
const valToAngle = (v, min, max, a0, a1) => a0 + ((v - min) / (max - min)) * (a1 - a0);

// Garis skala: defs urut dari step terbesar; satu <path> per jenis garis (hemat elemen DOM)
function ticks(cx, cy, a0, a1, min, max, rOut, defs) {
    const small = defs[defs.length - 1].step, n = Math.round((max - min) / small);
    const d = defs.map(() => '');
    for (let i = 0; i <= n; i++) {
        const v = min + i * small;
        const k = defs.findIndex((t) => Math.abs((v - min) / t.step - Math.round((v - min) / t.step)) < 1e-6);
        const a = valToAngle(v, min, max, a0, a1);
        const [x1, y1] = pt(cx, cy, rOut - defs[k].len, a), [x2, y2] = pt(cx, cy, rOut, a);
        d[k] += `M${x1} ${y1}L${x2} ${y2}`;
    }
    return defs.map((t, i) => `<path class="tk ${t.cls}" stroke-width="${t.w}" d="${d[i]}"/>`).join('');
}
// Angka skala (rx/ry berbeda = posisi pada elips)
function labels(cx, cy, a0, a1, min, max, step, rx, ry, cls, fmt) {
    let s = '';
    for (let v = min; v <= max + 1e-6; v += step) {
        const a = (valToAngle(v, min, max, a0, a1) * Math.PI) / 180;
        s += `<text class="${cls}" x="${f2(cx + rx * Math.cos(a))}" y="${f2(cy + ry * Math.sin(a))}">${fmt ? fmt(v) : v}</text>`;
    }
    return s;
}

function bezel(c) {
    const { cx, cy, rf } = c;
    return `
    <circle cx="${cx}" cy="${cy}" r="${rf + 31}" fill="#040405"/>
    <circle cx="${cx}" cy="${cy}" r="${rf + 27}" fill="url(#chrome)"/>
    <circle cx="${cx}" cy="${cy}" r="${rf + 13}" fill="url(#chromeIn)"/>
    <circle cx="${cx}" cy="${cy}" r="${rf + 7}" fill="#08080a"/>
    <circle cx="${cx}" cy="${cy}" r="${rf}" fill="url(#face)"/>
    <circle cx="${cx}" cy="${cy}" r="${rf}" fill="url(#faceShade)"/>`;
}
const gloss = (c) => `<circle cx="${c.cx}" cy="${c.cy}" r="${c.rf}" fill="url(#gloss)" pointer-events="none"/>`;

function hub(cx, cy, r) {
    return `<circle cx="${cx}" cy="${cy}" r="${r + 3}" fill="rgba(0,0,0,0.35)"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#hubGrad)"/>
    <circle cx="${cx}" cy="${cy}" r="${f2(r * 0.55)}" fill="url(#hubCap)"/>`;
}
// Jarum digambar menunjuk ke +x lalu diputar lewat atribut transform (pivot = pusat dial)
function needleSvg(id, cx, cy, len, tail, tailW, baseW, startAngle) {
    const L = cx + len, b = cx + 8;
    return `<g id="${id}" transform="rotate(${startAngle} ${cx} ${cy})">
      <polygon class="ndl-shadow" points="${b},${cy - baseW + 3} ${L},${cy + 2} ${L},${cy + 4} ${b},${cy + baseW + 3}"/>
      <rect class="ndl-tail" x="${cx - tail}" y="${cy - tailW / 2}" width="${tail}" height="${tailW}" rx="3"/>
      <polygon class="ndl-body" points="${b},${cy - baseW} ${L},${cy - 1} ${L},${cy + 1} ${b},${cy + baseW}"/>
    </g>`;
}

// Ikon lampu (viewBox 24x24, memakai currentColor)
const ICONS = {
    oil: '<path fill="currentColor" stroke="none" d="M2.5 10h4.2l1.3-2h2V6.5H8V5h6v1.5h-2V8h2.5l2 1.8 5-2.8 1 1.2-6.6 7.3H8.4L7 13H2.5zM20.2 14.6c0-.9 1.1-2.3 1.1-2.3s1.1 1.4 1.1 2.3c0 .6-.5 1.1-1.1 1.1s-1.1-.5-1.1-1.1z"/>',
    battery: '<rect x="2.5" y="7" width="19" height="12" rx="1.5"/><path d="M6.5 7V4.8h3V7M14.5 7V4.8h3V7"/><path d="M6.5 13h3.2M16.6 11.4v3.2M15 13h3.2"/>',
    headlight: '<path d="M12 4h2a8 8 0 0 1 0 16h-2z" fill="currentColor" fill-opacity=".15"/><g class="beam-low"><path d="M9 5L2 7.5M9 9L2 11.5M9 13L2 15.5M9 17L2 19.5"/></g><g class="beam-high"><path d="M9 6H2M9 10H2M9 14H2M9 18H2"/></g>',
    seatbelt: '<circle cx="12" cy="4" r="2.2" fill="currentColor" stroke="none"/><path d="M8 22v-5.5L7 11.5C7 9.6 8.4 8 10.2 8h3.6C15.6 8 17 9.6 17 11.5l-1 5V22"/><path d="M9 8.5l7.5 10"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor" stroke="none"/><circle cx="12" cy="15.2" r="1.4" fill="#0a0b0d" stroke="none"/><path class="shackle-closed" d="M8 11V8a4 4 0 0 1 8 0v3"/><path class="shackle-open" d="M8 11V8a4 4 0 0 1 7.4-2.1"/>',
    engine: '<path d="M3 10.5v4M21 10.5v4M3 12.5H1.5" /><path d="M6 8h3.5V6H14v2h2.2l2.3 2.5H21v5h-2.5l-1.6 2H9.3L6 15.5z" stroke-width="1.8"/>',
};
// Urutan lampu (kiri -> kanan). id 'headlight', 'seatbelts', 'door-lock' dipakai oleh setter di bawah.
const LAMPS = [
    { id: 'lamp-oil',     x: 390,  icon: 'oil' },         // dekoratif
    { id: 'lamp-battery', x: 475,  icon: 'battery' },     // dekoratif
    { id: 'headlight',    x: 560,  icon: 'headlight' },   // setHeadlights
    { id: 'seatbelts',    x: 1060, icon: 'seatbelt' },    // setSeatbelts
    { id: 'door-lock',    x: 1145, icon: 'lock' },        // updateLockStatus
    { id: 'check-engine', x: 1230, icon: 'engine' },      // menyala saat health <= checkEngineHealthBelow
];
function lampSvg(l) {
    return `<g id="${l.id}" class="icon-item lamp" transform="translate(${l.x} ${LAMP_Y})">
      <circle class="pod" r="35"/><circle class="pod-in" r="30"/>
      <svg x="-18" y="-18" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[l.icon]}</svg>
    </g>`;
}
function screw(x, y) {
    return `<g transform="translate(${x} ${y})"><circle r="12" fill="url(#hubGrad)" stroke="rgba(255,255,255,0.12)" stroke-width="1.5"/><path d="M-6 -2L6 2M-2 6L2 -6" stroke="rgba(255,255,255,0.28)" stroke-width="1.6" stroke-linecap="round"/></g>`;
}

// Jarum: id elemen, pusat, panjang, ekor, lebar ekor, lebar pangkal, radius hub
const N = {
    rpm:   { id: 'needle-rpm',   cx: G.rpm.cx,   cy: G.rpm.cy,   len: 182, tail: 42, tailW: 20, baseW: 4.5, hub: 31, a0: 'rpmAngleStart',   a1: 'rpmAngleEnd',   rate: 'needleResponse' },
    speed: { id: 'needle-speed', cx: G.speed.cx, cy: G.speed.cy, len: 244, tail: 48, tailW: 23, baseW: 5.5, hub: 36, a0: 'speedAngleStart', a1: 'speedAngleEnd', rate: 'speedResponse' },
    fuel:  { id: 'needle-fuel',  cx: FP.x,       cy: FP.y,       len: 98,  tail: 30, tailW: 16, baseW: 3.5, hub: 26, a0: 'fuelAngleStart',  a1: 'fuelAngleEnd',  rate: 'fuelResponse' },
    oil:   { id: 'needle-oil',   cx: OP.x,       cy: OP.y,       len: 116, tail: 30, tailW: 16, baseW: 3.5, hub: 26, a0: 'oilAngleStart',   a1: 'oilAngleEnd',   rate: 'oilResponse' },
};
Object.keys(N).forEach((k) => Object.assign(N[k], { shown: 0, el: null, lastA: NaN }));   // shown = posisi 0..1 pada skala
const odo = { cells: [], last: '' };

function buildCluster() {
    const R = G.rpm, S = G.speed, D = G.side;
    const rpmA0 = CFG.rpmAngleStart, rpmA1 = CFG.rpmAngleEnd, rMin = CFG.rpmMin, rMax = CFG.rpmMax;
    const redA = valToAngle(CFG.redlineStart, rMin, rMax, rpmA0, rpmA1);
    const redB = valToAngle(Math.min(CFG.redlineEnd, rMax), rMin, rMax, rpmA0, rpmA1);

    let s = `
    <defs>
      <linearGradient id="housing" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#222428"/><stop offset="1" stop-color="#0a0a0c"/></linearGradient>
      <linearGradient id="chrome" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#f4f4f5"/><stop offset="0.28" stop-color="#8a8d92"/><stop offset="0.5" stop-color="#1c1d20"/>
        <stop offset="0.74" stop-color="#a3a8ae"/><stop offset="1" stop-color="#ececed"/></linearGradient>
      <linearGradient id="chromeIn" x1="1" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="#d8d9db"/><stop offset="0.3" stop-color="#5b5e63"/><stop offset="0.55" stop-color="#101113"/>
        <stop offset="1" stop-color="#9ea3a9"/></linearGradient>
      <radialGradient id="face"><stop offset="0" style="stop-color:var(--face-a)"/><stop offset="1" style="stop-color:var(--face-b)"/></radialGradient>
      <radialGradient id="faceShade"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="0.8" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.26"/></radialGradient>
      <linearGradient id="gloss" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.26"/><stop offset="0.42" stop-color="#fff" stop-opacity="0"/></linearGradient>
      <radialGradient id="hubGrad" cx="0.38" cy="0.32" r="0.8"><stop offset="0" stop-color="#4a4b50"/><stop offset="0.55" stop-color="#17181a"/><stop offset="1" stop-color="#050506"/></radialGradient>
      <radialGradient id="hubCap" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#2c2d31"/><stop offset="1" stop-color="#070708"/></radialGradient>
      <radialGradient id="podGrad" cx="0.5" cy="0.35" r="0.8"><stop offset="0" stop-color="#202226"/><stop offset="1" stop-color="#060607"/></radialGradient>
    </defs>

    <!-- bodi klaster -->
    <circle cx="${S.cx}" cy="${S.cy}" r="314" fill="url(#housing)" stroke="rgba(255,255,255,0.07)" stroke-width="1.5"/>
    <rect x="20" y="95" width="1560" height="580" rx="125" fill="url(#housing)" stroke="rgba(255,255,255,0.07)" stroke-width="1.5"/>
    <rect x="342" y="574" width="266" height="86" rx="43" fill="#0a0b0c"/>
    <rect x="1012" y="574" width="266" height="86" rx="43" fill="#0a0b0c"/>
    ${screw(443, 110)}${screw(1180, 112)}${screw(495, 528)}${screw(1123, 528)}${screw(722, 650)}${screw(895, 650)}

    <!-- ===== RPM ===== -->
    ${bezel(R)}
    <path class="zone" d="${sector(R.cx, R.cy, 166, 194, redA, redB)}"/>
    ${ticks(R.cx, R.cy, rpmA0, rpmA1, rMin, rMax, 194, [
        { step: 1000, len: 38, w: 3.6, cls: 'maj' }, { step: 200, len: 17, w: 1.5, cls: 'min' }])}
    ${labels(R.cx, R.cy, rpmA0, rpmA1, rMin, rMax, 1000, 138, 138, 'num num-rpm', (v) => v / 1000)}
    <text class="lbl lbl-lg" x="${R.cx}" y="${R.cy + 72}">RPM</text>
    <text class="lbl lbl-sm" x="${R.cx}" y="${R.cy + 98}">x1000</text>
    ${gloss(R)}

    <!-- ===== SPEEDOMETER ===== -->
    ${bezel(S)}
    ${ticks(S.cx, S.cy, CFG.speedAngleStart, CFG.speedAngleEnd, 0, CFG.speedMax, 258, [
        { step: 20, len: 40, w: 3.8, cls: 'maj' }, { step: 10, len: 28, w: 2.4, cls: 'mid' }, { step: 2, len: 15, w: 1.3, cls: 'min' }])}
    ${labels(S.cx, S.cy, CFG.speedAngleStart, CFG.speedAngleEnd, 0, CFG.speedMax, 20, 192, 192, 'num num-speed')}
    <text class="lbl lbl-lg" x="${S.cx}" y="${S.cy - 82}">MPH</text>
    <text class="lbl lbl-md" x="${S.cx}" y="${S.cy + 179}">MILES</text>
    ${gloss(S)}

    <!-- ===== FUEL + OIL PRESS ===== -->
    ${bezel(D)}
    <path class="zone" d="${sector(FP.x, FP.y, 104, 126, CFG.fuelAngleStart, CFG.fuelAngleStart + CFG.fuelLowZone * (CFG.fuelAngleEnd - CFG.fuelAngleStart))}"/>
    ${ticks(FP.x, FP.y, CFG.fuelAngleStart, CFG.fuelAngleEnd, 0, 12, 126, [
        { step: 6, len: 22, w: 3.2, cls: 'maj' }, { step: 1, len: 13, w: 1.6, cls: 'min' }])}
    <text class="lbl lbl-md" x="${FP.x - 130}" y="${FP.y - 22}">E</text>
    <text class="lbl lbl-md" x="${FP.x + 127}" y="${FP.y - 23}">F</text>
    <svg class="fuel-icon" x="${FP.x - 17}" y="${FP.y - 88}" width="34" height="34" viewBox="0 0 24 24" fill="currentColor"><path d="M19.77 7.23l.01-.01-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33 0 1.38 1.12 2.5 2.5 2.5.36 0 .69-.08 1-.21v7.21c0 .55-.45 1-1 1s-1-.45-1-1V14c0-1.1-.9-2-2-2h-1V5c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v16h10v-7.5h1.5v5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V9c0-.69-.28-1.32-.73-1.77zM12 10H6V5h6v5zm6 0c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z"/></svg>
    <text class="lbl lbl-md" x="${FP.x}" y="${FP.y + 47}">FUEL</text>
    <path class="sep" d="M${D.cx - 118} ${D.cy + 20}Q${D.cx} ${D.cy - 8} ${D.cx + 118} ${D.cy + 20}"/>
    <path class="sep-hi" d="M${D.cx - 118} ${D.cy + 22}Q${D.cx} ${D.cy - 6} ${D.cx + 118} ${D.cy + 22}"/>
    ${ticks(OP.x, OP.y, CFG.oilAngleStart, CFG.oilAngleEnd, 0, CFG.oilMaxPsi, 68, [
        { step: 20, len: 15, w: 3.2, cls: 'maj' }, { step: 10, len: 8, w: 1.6, cls: 'min' }])}
    ${labels(OP.x, OP.y, CFG.oilAngleStart, CFG.oilAngleEnd, 0, CFG.oilMaxPsi, 20, 120, 90, 'num num-side')}
    <text class="lbl lbl-md oil-label" x="${OP.x}" y="${OP.y + 44}">OIL PRESS</text>
    <text class="lbl lbl-sm" x="${OP.x}" y="${OP.y + 66}">PSI</text>
    ${gloss(D)}

    <!-- ===== ODOMETER ===== -->
    <rect class="odo-box" x="${S.cx - 92}" y="${S.cy + 119}" width="184" height="46" rx="7"/>`;
    for (let i = 1; i < 6; i++) s += `<line class="odo-sep" x1="${S.cx - 90 + i * 30.5}" y1="${S.cy + 122}" x2="${S.cx - 90 + i * 30.5}" y2="${S.cy + 162}"/>`;
    for (let i = 0; i < 6; i++) s += `<text class="odo-dig" id="odo-${i}" x="${S.cx - 74.75 + i * 30.5}" y="${S.cy + 143}">0</text>`;

    // ===== JARUM (di atas semua skala) =====
    s += needleSvg(N.rpm.id, N.rpm.cx, N.rpm.cy, N.rpm.len, N.rpm.tail, N.rpm.tailW, N.rpm.baseW, rpmA0) + hub(N.rpm.cx, N.rpm.cy, N.rpm.hub);
    s += needleSvg(N.fuel.id, N.fuel.cx, N.fuel.cy, N.fuel.len, N.fuel.tail, N.fuel.tailW, N.fuel.baseW, CFG.fuelAngleStart) + hub(N.fuel.cx, N.fuel.cy, N.fuel.hub);
    s += needleSvg(N.oil.id, N.oil.cx, N.oil.cy, N.oil.len, N.oil.tail, N.oil.tailW, N.oil.baseW, CFG.oilAngleStart) + hub(N.oil.cx, N.oil.cy, N.oil.hub);
    s += needleSvg(N.speed.id, N.speed.cx, N.speed.cy, N.speed.len, N.speed.tail, N.speed.tailW, N.speed.baseW, CFG.speedAngleStart) + hub(N.speed.cx, N.speed.cy, N.speed.hub);

    // ===== LAMPU =====
    s += LAMPS.map(lampSvg).join('');
    svg.innerHTML = s;

    Object.keys(N).forEach((k) => { N[k].el = $(N[k].id); N[k].lastA = NaN; });
    odo.cells = [0, 1, 2, 3, 4, 5].map((i) => $('odo-' + i));
    odo.last = '';
    renderOdometer();
    syncLamps();
}
/* =========================================================
   4. STATE
   ========================================================= */
const state = {
    mph: 0,
    mps: 0,            // kecepatan mentah (m/s)
    rpmRatio: 0,       // 0-1 dari game (1.0 = revLimit)
    rpmStamp: 0,       // kapan setRPM terakhir dipanggil (untuk dataTimeoutMs)
    health: 1,         // 0-1
    fuel: 0,           // 0-1
    belted: false,
    engine: false,     // dari setEngine(); alarm hanya bunyi saat mesin hidup
    engineSeenOn: false,
    limiterFlag: null, // null = deteksi otomatis, true/false = status dari game
    odo: 0,
    headlights: 0,
    locked: false,
};
let bootUntil = performance.now() + 1700;
const BOOT_MS = 1700;

const lim = { active: false, hold: 0, rel: 0, env: 0 };      // status limiter (detektor + envelope getaran)
const dbg = { base: 0, shake: 0, final: 0 };                  // untuk hudDebug()

/* =========================================================
   5. LIMITER  (deteksi + offset getaran; dipisah dari sudut dasar jarum)
   ========================================================= */
function approach(v, target, maxStep) { return v < target ? Math.min(target, v + maxStep) : Math.max(target, v - maxStep); }

// Dipanggil sekali per frame dengan nilai RPM mentah (BUKAN yang sudah di-smooth) supaya deteksi tidak terlambat.
function updateLimiter(dt, ratio) {
    const allowed = !(state.engineSeenOn && !state.engine);     // mesin dimatikan -> limiter tidak mungkin aktif
    if (!allowed) {
        lim.active = false; lim.hold = 0; lim.rel = 0;
    } else if (state.limiterFlag !== null) {                    // status dari game dipakai apa adanya
        lim.active = state.limiterFlag; lim.hold = 0; lim.rel = 0;
    } else if (!lim.active) {
        // RPM >= threshold terus-menerus (atau nyaris terus-menerus) -> baru dianggap limiter. Lewat sebentar = bukan limiter.
        if (ratio >= CFG.limiterThreshold) lim.hold += dt; else lim.hold = Math.max(0, lim.hold - dt);
        if (lim.hold >= CFG.limiterHoldTime) { lim.active = true; lim.rel = 0; }
    } else {
        // Sudah aktif: fluktuasi di antara releaseThreshold dan 1.0 tidak melepas limiter (hysteresis)
        if (ratio < CFG.limiterReleaseThreshold) lim.rel += dt; else lim.rel = 0;
        if (lim.rel >= CFG.limiterReleaseTime) { lim.active = false; lim.hold = 0; lim.rel = 0; }
    }
    // Envelope: getaran naik cepat, memudar halus
    const tgt = lim.active ? 1 : 0;
    const rate = tgt > lim.env ? 1 / Math.max(0.001, CFG.limiterAttackTime) : 1 / Math.max(0.001, CFG.limiterRecoverTime);
    lim.env = approach(lim.env, tgt, rate * dt);
    elHudToggle('limiter', lim.active);
}
// Offset getaran (derajat) untuk waktu t (detik). Dihitung ulang tiap frame dari t, TIDAK diakumulasi.
// Tiga gelombang berfrekuensi tidak sebanding + modulasi amplitudo lambat -> getaran terasa mekanis, tidak monoton.
// Nilai mutlak selalu <= limiterShakeAmplitude * env.
function limiterShakeOffset(t, env) {
    if (env <= 0.0005) return 0;
    const w = 2 * Math.PI, f = CFG.limiterShakeFrequency;
    const s = 0.55 * Math.sin(w * f * t) + 0.30 * Math.sin(w * f * 1.61 * t + 1.3) + 0.15 * Math.sin(w * f * 2.37 * t + 2.1);
    const m = 0.8 + 0.2 * Math.sin(w * 3.1 * t + 0.7);
    return CFG.limiterShakeAmplitude * env * s * m;
}

const hudFlags = {};
function elHudToggle(cls, on) { if (hudFlags[cls] !== on) { hudFlags[cls] = on; elHud.classList.toggle(cls, on); } }

buildCluster();                                      // semua deklarasi (state, lim, hudFlags) sudah siap

/* =========================================================
   6. LOOP ANIMASI (satu rAF; berhenti saat tidak ada yang bergerak)
   ========================================================= */
const ang = (n, t) => { const a0 = CFG[n.a0], a1 = CFG[n.a1]; return a0 + clamp01(t) * (a1 - a0); };
function drawNeedle(n, a) {
    if (Math.abs(a - n.lastA) < 0.02) return;       // tulis ke SVG hanya kalau jarum benar-benar bergerak
    n.lastA = a;
    n.el.setAttribute('transform', 'rotate(' + a.toFixed(2) + ' ' + n.cx + ' ' + n.cy + ')');
}
// Kembalikan true kalau jarum masih bergerak
function stepNeedle(n, target, dt, rate, instant, capped) {
    if (instant) { n.shown = target; return false; }
    const d = target - n.shown;
    if (Math.abs(d) < 0.00015) { n.shown = target; return false; }
    let step = d * (1 - Math.exp(-rate * dt));      // eksponensial berbasis waktu -> sama di FPS berapa pun
    if (capped && CFG.needleMaxSpeed > 0) {         // batas kecepatan fisik jarum (lonjakan besar tetap terlihat menyapu)
        const maxStep = (CFG.needleMaxSpeed * dt) / Math.abs(CFG[n.a1] - CFG[n.a0]);
        step = clamp(step, -maxStep, maxStep);
    }
    n.shown += step;
    return Math.abs(target - n.shown) >= 0.00015;
}
const smooth = (x) => x * x * (3 - 2 * x);
function bootCurve(t) {                              // sapuan jarum saat kontak ON: 0 -> max -> 0
    if (t < 0.45) return smooth(t / 0.45);
    if (t < 0.55) return 1;
    return smooth(Math.max(0, 1 - (t - 0.55) / 0.45));
}

const rpmNorm = (ratio) => clamp01((ratio * CFG.revLimit - CFG.rpmMin) / (CFG.rpmMax - CFG.rpmMin));
const oilNorm = (health) => clamp01((health * CFG.oilPsiAtFullHealth) / CFG.oilMaxPsi);

let lastFrame = 0, rafId = 0;
function kick() {                                    // bangunkan loop kalau sedang berhenti
    if (rafId) return;
    lastFrame = performance.now() - FRAME_MS;
    rafId = requestAnimationFrame(frame);
}
function frame(now) {
    rafId = 0;
    if (now - lastFrame < FRAME_MS - 2) { rafId = requestAnimationFrame(frame); return; }   // batas FPS
    const dt = clamp((now - lastFrame) / 1000, 0.001, 0.1);
    lastFrame = now;
    let busy = false;

    const booting = now < bootUntil;
    const boot = booting ? bootCurve(1 - (bootUntil - now) / BOOT_MS) : 0;
    if (!booting && elHud.classList.contains('booting')) elHud.classList.remove('booting');

    // --- RPM (ratio mentah; kalau data basi dan dataTimeoutMs aktif -> 0)
    let ratio = state.rpmRatio;
    if (CFG.dataTimeoutMs > 0 && state.rpmStamp && now - state.rpmStamp > CFG.dataTimeoutMs) ratio = 0;

    // --- Limiter (tidak aktif saat sapuan boot)
    if (booting) { lim.active = false; lim.hold = 0; lim.rel = 0; lim.env = 0; elHudToggle('limiter', false); }
    else updateLimiter(dt, ratio);

    // --- Sudut dasar RPM (di-smooth), lalu offset getaran ditambahkan SETELAH smoothing
    const rpmT = booting ? boot : rpmNorm(ratio);
    const fall = rpmT < N.rpm.shown ? 1 - 0.5 * clamp01(CFG.needleSmoothing) : 1;
    busy = stepNeedle(N.rpm, rpmT, dt, CFG.needleResponse * fall, booting, true) || busy;
    const a0 = CFG.rpmAngleStart, a1 = CFG.rpmAngleEnd;
    const base = ang(N.rpm, N.rpm.shown);
    const shake = limiterShakeOffset(now / 1000, lim.env);
    const finalA = clamp(base + shake, Math.min(a0, a1), Math.max(a0, a1));   // tidak pernah keluar skala
    dbg.base = base; dbg.shake = shake; dbg.final = finalA;
    drawNeedle(N.rpm, finalA);
    elHudToggle('redline', ratio * CFG.revLimit >= CFG.redlineStart);

    // --- Speed / Fuel / Oil press
    busy = stepNeedle(N.speed, booting ? boot : clamp01(state.mph / CFG.speedMax), dt, CFG.speedResponse, booting, true) || busy;
    drawNeedle(N.speed, ang(N.speed, N.speed.shown));
    busy = stepNeedle(N.fuel, booting ? boot : state.fuel, dt, CFG.fuelResponse, booting) || busy;
    drawNeedle(N.fuel, ang(N.fuel, N.fuel.shown));
    busy = stepNeedle(N.oil, booting ? boot : oilNorm(state.health), dt, CFG.oilResponse, booting) || busy;
    drawNeedle(N.oil, ang(N.oil, N.oil.shown));

    // lanjut hanya kalau masih ada yang bergerak / limiter sedang aktif atau sedang dihitung
    const limiterBusy = lim.active || lim.env > 0.0005 || lim.hold > 0 || lim.rel > 0;
    if (booting || busy || limiterBusy) rafId = requestAnimationFrame(frame);
}

/* =========================================================
   7. LAMPU & ODOMETER (render)
   ========================================================= */
function lampClass(extra) { return 'icon-item lamp' + (extra ? ' ' + extra : ''); }
function syncLamps() {
    setClass($('headlight'), lampClass(state.headlights === 2 ? 'high-beam' : state.headlights === 1 ? 'active' : ''));
    setClass($('seatbelts'), lampClass(state.belted ? 'active' : 'warn'));
    setClass($('door-lock'), lampClass(state.locked ? 'locked' : ''));
    const ce = state.health <= CFG.checkEngineHealthBelow;
    setClass($('check-engine'), lampClass(ce ? 'engine-warn' : ''));
    elHudToggle('engine-warn', ce);
}
function renderOdometer() {
    const s = String(Math.floor(Math.max(0, state.odo)) % 1000000).padStart(6, '0');
    if (s === odo.last) return;
    odo.last = s;
    for (let i = 0; i < 6; i++) setText(odo.cells[i], s[i]);
}

/* =========================================================
   8. API PUBLIK  (jalur data tunggal: semua sumber -> fungsi ini -> state -> loop)
   ========================================================= */
const api = {};

// 1. Kecepatan (m/s)
api.setSpeed = function (speed) {
    const v = finite(speed);
    if (v === null) return;
    state.mps = Math.abs(v);
    state.mph = Math.round(state.mps * MPS_TO_MPH);
    kick();
};

// 2. RPM (0.0 - 1.0; 1.0 = revLimit)
api.setRPM = function (rpm) {
    const v = finite(rpm);
    if (v === null) return;                      // data tidak valid / hilang: jarum tetap, UI tidak rusak
    state.rpmStamp = performance.now();
    const r = clamp01(v);
    if (r === state.rpmRatio) { kick(); return; }
    state.rpmRatio = r;
    kick();
};

// 3. Fuel
api.setFuel = function (fuel) {
    const v = finite(fuel);
    if (v === null) return;
    state.fuel = clamp01(v > 1 ? v / 100 : v);
    elHudToggle('fuel-low', state.fuel < 0.20);
    kick();
};

// 4. Engine Health -> jarum OIL PRESS + lampu CHECK ENGINE (<= 50%)
api.setHealth = function (health) {
    const v = finite(health);
    if (v === null) return;
    const percent = clamp01(v > 1 ? v / 1000 : v);
    state.health = percent;
    elHudToggle('oil-warn', percent <= 0.5 && percent > 0.3);
    elHudToggle('oil-crit', percent <= 0.3);
    syncLamps();
    kick();
};

// 5. Gear (tidak ditampilkan di desain klaster; data tetap diterima)
api.setGear = function (gear) {
    let g = String(gear);
    if (gear == 0 || g === '0' || g.toUpperCase() === 'R') g = 'R';
    else if (gear === null || gear === undefined || g === '' || g.toUpperCase() === 'N') g = 'N';
    setText($('gear'), g);
};

// 6. Lock / Unlock Vehicle (mendukung semua alternatif panggilan JGRP)
api.updateLockStatus = function (v) {
    state.locked = isLockedState(v);
    elHudToggle('is-locked', state.locked);
    syncLamps();
};
['setDoors', 'setDoorLock', 'setVehicleLocked', 'setLocked', 'setLock', 'toggleLock'].forEach((n) => { api[n] = api.updateLockStatus; });

// 7. Lampu (0 = mati, 1 = low beam, 2 = high beam)
api.setHeadlights = function (v) {
    const val = Number(v || 0);
    state.headlights = val === 2 ? 2 : val === 1 ? 1 : 0;
    syncLamps();
};

// 8. Sein (dinonaktifkan di desain)
api.setLeftIndicator = function () {};
api.setRightIndicator = function () {};

// 9. Seatbelt (true = terpasang)
api.setSeatbelts = function (v) {
    state.belted = isTrueValue(v);
    syncLamps();
};

// 10. Odometer (mil)
api.setOdometer = function (distance) {
    const v = finite(distance);
    if (v === null) return;
    state.odo = v;
    renderOdometer();
};

// 11. Engine (setEngine(true/false)): alarm hanya bunyi saat mesin hidup; limiter tidak aktif saat mesin mati
api.setEngine = function (on) {
    state.engine = isTrueValue(on);
    if (state.engine) state.engineSeenOn = true;
    kick();
};

// ----- Baru: limiter & konfigurasi -----
api.setLimiter = function (v) {                  // true/false = status dari game, null/undefined = deteksi otomatis
    state.limiterFlag = (v === null || v === undefined) ? null : isTrueValue(v);
    kick();
};
api.setRevLimit = function (rpm) {
    let v = finite(rpm);
    if (v === null || v <= 0) return;
    if (v <= 20) v *= 1000;                      // 8 -> 8000
    CFG.revLimit = v;
    kick();
};
api.setConfig = function (cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    let rebuild = false;
    Object.keys(cfg).forEach((k) => {
        if (!(k in DEFAULTS)) return;
        const v = finite(cfg[k]);
        if (v === null) return;
        CFG[k] = v;
        if (GEOMETRY_KEYS.indexOf(k) >= 0) rebuild = true;
    });
    FRAME_MS = 1000 / clamp(CFG.maxFps, 10, 240);
    if (rebuild) buildCluster();
    kick();
};
api.setTemp = (c) => { const v = finite(c); if (v !== null) setText($('temp-val'), Math.round(v)); };

// ----- Intro (bisa dipanggil ulang: playIntro()) -----
let introTimer;
api.playIntro = function () {
    elHud.classList.remove('intro-on');
    void elHud.offsetWidth;                      // restart animasi CSS
    elHud.classList.add('intro-on');
    elHud.classList.add('booting');
    bootUntil = performance.now() + BOOT_MS;     // semua jarum ikut menyapu
    kick();
    clearTimeout(introTimer);
    introTimer = setTimeout(() => elHud.classList.remove('intro-on'), 2750);
};

// Teks intro: ganti di index.html pada data-text="OBEY" (huruf & ukuran diatur otomatis)
(function () {
    const el = $('intro-text');
    if (el === NOOP_EL) return;
    const text = (el.dataset.text || el.textContent || 'OBEY').trim().toUpperCase();
    const chars = Array.from(text);
    el.textContent = '';
    chars.forEach((ch, i) => {
        const span = document.createElement('span');
        span.textContent = ch === ' ' ? ' ' : ch;
        span.style.animationDelay = (0.3 + i * 0.09).toFixed(2) + 's';
        el.appendChild(span);
    });
    el.style.fontSize = Math.max(1.2, Math.min(3.0, 11 / chars.length)).toFixed(2) + 'em';   // em = 1% lebar klaster
})();

/* =========================================================
   9. SUARA PERINGATAN (Web Audio, tanpa file mp3) - tidak diubah dari versi sebelumnya
   ========================================================= */
const SND = {
    enabled: true,
    volume: 0.3,            // 0 - 1
    seatbeltEvery: 2000,    // ms jeda antar bunyi seatbelt (berulang terus sampai seatbelt dipasang)
    seatbeltMinSpeed: 1,    // m/s: seatbelt hanya bunyi saat mobil bergerak lebih cepat dari ini
    fuelBelow: 0.20,        // bensin di bawah 20%
    fuelEvery: 30000,       // ms jeda antar chime bensin
};
// Matikan via link: ?nosound / ?mute / ?silent / ?noalarm   Volume via link: ?volume=0.0-1.0
try {
    const q = new URLSearchParams(location.search);
    ['nosound', 'mute', 'silent', 'noalarm', 'noseatbelt', 'nobelt'].forEach((k) => {
        if (q.has(k) && !['0', 'false', 'no', 'off'].includes((q.get(k) || '').toLowerCase())) SND.enabled = false;
    });
    if (q.has('volume') && !isNaN(parseFloat(q.get('volume')))) SND.volume = clamp01(parseFloat(q.get('volume')));
} catch (e) { /* abaikan */ }
let audioCtx = null;
function getAudio() {
    if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
}
function tone(freq, start, dur, type, vol) {
    const a = getAudio();
    if (!a) return;
    const t0 = a.currentTime + start;
    const osc = a.createOscillator(), gain = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, SND.volume * vol), t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
}
api.playHudSound = function (kind) {
    if (!SND.enabled) return;
    if (kind === 'seatbelt') {                       // beep-beep
        tone(1000, 0.00, 0.14, 'triangle', 1);
        tone(1000, 0.22, 0.14, 'triangle', 1);
    } else if (kind === 'fuel') {                    // ding-dong
        tone(988, 0.00, 0.45, 'sine', 1);
        tone(1976, 0.00, 0.30, 'sine', 0.25);
        tone(740, 0.30, 0.70, 'sine', 1);
        tone(1480, 0.30, 0.45, 'sine', 0.25);
    }
};
api.setHudSound = function (on, volume) {
    SND.enabled = !!on;
    if (volume !== undefined) SND.volume = clamp01(Number(volume));
};
api.setSeatbeltSoundEnabled = (on) => api.setHudSound(!!on);
api.setSeatbeltVolume = (v) => { const n = parseFloat(v); if (!isNaN(n)) api.setHudSound(SND.enabled, n); };
// Browser butuh interaksi pertama untuk membuka audio (di CEF/FiveM biasanya langsung jalan)
['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, getAudio, { once: true }));

let lastSeatBeep = -Infinity, lastFuelChime = -Infinity;
setInterval(() => {                                  // pengecek alarm (bukan animasi jarum)
    if (!SND.enabled || elHud.classList.contains('intro-on')) return;
    const now = performance.now();
    const seatWarn = state.engine && !state.belted && state.mps > SND.seatbeltMinSpeed;
    if (!seatWarn) lastSeatBeep = -Infinity;
    else if (now - lastSeatBeep >= SND.seatbeltEvery) { lastSeatBeep = now; api.playHudSound('seatbelt'); }
    const fuelWarn = state.engine && state.fuel < SND.fuelBelow;
    if (!fuelWarn) lastFuelChime = -Infinity;
    else if (now - lastFuelChime >= SND.fuelEvery) { lastFuelChime = now; api.playHudSound('fuel'); }
}, 250);

/* =========================================================
   10. TEMA JARUM
   ========================================================= */
const THEMES = [['lfa', 'Merah Klasik'], ['night', 'Oranye'], ['ice', 'Biru Es'], ['amber', 'Amber'], ['mono', 'Hijau']];
let themeIdx = 0;
api.setTheme = function (name) {
    let i = typeof name === 'number' ? name : THEMES.findIndex((t) => t[0] === name);
    if (i < 0) i = 0;
    themeIdx = ((i % THEMES.length) + THEMES.length) % THEMES.length;
    document.body.dataset.theme = THEMES[themeIdx][0];
    setText($('theme-name'), THEMES[themeIdx][1]);
    try { localStorage.setItem('hudTheme', THEMES[themeIdx][0]); } catch (e) { /* abaikan */ }
};
api.nextTheme = () => api.setTheme(themeIdx + 1);

/* =========================================================
   11. PESAN NUI  (satu listener; payload sama dengan versi sebelumnya + aksi baru)
   ========================================================= */
const ACTIONS = {
    setEngine:     (d) => api.setEngine(d.state),
    setSpeed:      (d) => api.setSpeed(d.speed),
    setRPM:        (d) => api.setRPM(d.rpm),
    setFuel:       (d) => api.setFuel(d.fuel),
    setHealth:     (d) => api.setHealth(d.health),
    setGear:       (d) => api.setGear(d.gear !== undefined ? d.gear : 'N'),
    setHeadlights: (d) => api.setHeadlights(d.state),
    setSeatbelts:  (d) => api.setSeatbelts(d.state),
    setOdometer:   (d) => api.setOdometer(d.distance),
    setLimiter:    (d) => api.setLimiter(d.state !== undefined ? d.state : d.limiter),
    setRevLimit:   (d) => api.setRevLimit(d.rpm !== undefined ? d.rpm : d.revLimit),
    setConfig:     (d) => api.setConfig(d.config || d),
    setTemp:       (d) => api.setTemp(d.temp !== undefined ? d.temp : d.state),
    setDoors:      (d) => api.updateLockStatus(d.status !== undefined ? d.status : d.state),
    playIntro:     () => api.playIntro(),
    setTheme:      (d) => api.setTheme(d.theme !== undefined ? d.theme : d.state),
    nextTheme:     () => api.nextTheme(),
    muteSeatbelt:  () => api.setSeatbeltSoundEnabled(false),
    unmuteSeatbelt: () => api.setSeatbeltSoundEnabled(true),
    setSeatbeltSound: (d) => api.setSeatbeltSoundEnabled(d.enabled !== undefined ? !!d.enabled : !d.disabled),
    setVolume:     (d) => api.setSeatbeltVolume(d.volume !== undefined ? d.volume : d.value),
};
let onRealData = function () {};                     // diisi oleh demo: data asli dari game menghentikan simulasi
window.addEventListener('message', function (event) {
    const d = event.data;
    if (!d || typeof d !== 'object') return;
    let key = d.action;
    if (!key && d.type === 'lock') key = 'setDoors';
    if (!key && (d.type === 'setDoors' || d.type === 'playIntro')) key = d.type;
    const fn = key && Object.prototype.hasOwnProperty.call(ACTIONS, key) ? ACTIONS[key] : null;
    if (!fn) return;
    onRealData();
    try { fn(d); } catch (e) { /* abaikan pesan rusak */ }
});

/* =========================================================
   12. EKSPOR KE window + NILAI AWAL
   ========================================================= */
Object.assign(window, api);
window.hudConfig = CFG;                              // bisa diubah langsung dari console, mis. hudConfig.revLimit = 7500
window.hudDebug = function () {
    return {
        rpmRatio: state.rpmRatio, rpmShown: N.rpm.shown, baseAngle: dbg.base, shakeOffset: dbg.shake, finalAngle: dbg.final,
        limiter: { active: lim.active, env: lim.env, hold: lim.hold, rel: lim.rel, flag: state.limiterFlag },
        speedAngle: N.speed.lastA, fuelAngle: N.fuel.lastA, oilAngle: N.oil.lastA,
        health: state.health, checkEngine: $('check-engine').getAttribute('class'), loopRunning: !!rafId,
        booting: elHud.classList.contains('booting'),
    };
};

// Nilai awal (hanya inisialisasi; data game menimpanya begitu datang)
api.setSpeed(0);
api.setRPM(0);
api.setFuel(100);
api.setHealth(1000);
api.setGear('N');
api.setHeadlights(0);
api.setSeatbelts(false);
api.setEngine(false);
api.updateLockStatus(false);
api.setOdometer(0);
state.rpmStamp = 0;                                  // nilai awal bukan data game -> jangan dihitung basi
(function () {
    const q = new URLSearchParams(location.search);
    if (q.has('button')) document.body.classList.add('show-btn');
    let saved = q.get('theme');
    try { saved = saved || localStorage.getItem('hudTheme'); } catch (e) { /* abaikan */ }
    api.setTheme(saved || 'lfa');
})();
$('theme-btn').addEventListener('click', api.nextTheme);
window.addEventListener('keydown', (e) => { if (e.key === 't' || e.key === 'T') api.nextTheme(); });

api.playIntro();                                     // animasi intro saat HUD pertama kali dipakai

/* =========================================================
   13. MODE BROWSER PREVIEW + PENGUJIAN  (hanya aktif dengan ?demo atau di preview Netlify)
   Tidak aktif di FiveM NUI. Pesan data asli (postMessage) otomatis menghentikan simulasi.
   ========================================================= */
const params = new URLSearchParams(location.search);
const isPreview = params.has('demo') || (/netlify\.app$/.test(location.hostname) && !params.has('nodemo'));

if (isPreview) {
    document.body.classList.add('preview');

    const GEAR_TOP = [0, 28, 48, 72, 98, 128, 165];   // batas mph per gigi
    const drive = { mps: 0, gear: 1, throttle: true, odo: 18452.3, health: 1000, fuel: 86, t: 0 };

    // Skenario RPM: fungsi (detik sejak skenario mulai) -> ratio 0..1, atau undefined (= tidak kirim data)
    const SCEN = {
        auto:    null,                                                       // simulasi berkendara lengkap
        idle:    (t) => 0.20 + 0.004 * Math.sin(t * 9),
        slow:    (t) => { const p = (t % 16) / 16; return p < 0.5 ? 0.2 + 0.7 * (p / 0.5) : 0.9 - 0.7 * ((p - 0.5) / 0.5); },
        fast:    (t) => (Math.floor(t / 1.6) % 2 === 0 ? 0.2 : 0.95),
        high:    (t) => 0.90 + 0.01 * Math.sin(t * 5),                       // tinggi tapi BUKAN limiter
        limiter: (t) => { const c = t % 9; return c < 1 ? 0.5 + 0.5 * c : c < 6 ? 0.995 + 0.005 * Math.sin(t * 40) - 0.004 * Math.abs(Math.sin(t * 13)) : 0.55; },
        fluct:   (t) => 0.985 + 0.015 * Math.sin(t * 2 * Math.PI * 3),       // berfluktuasi di sekitar threshold
        off:     () => 0,
        nodata:  () => undefined,
    };
    const sim = { running: false, mode: 'auto', t0: 0, timer: 0 };

    function feed() {
        const now = performance.now(), ts = (now - sim.t0) / 1000;
        drive.t += 0.05;
        const mph = drive.mps * MPS_TO_MPH;
        let rpm;
        if (sim.mode === 'auto') {
            if (drive.throttle) drive.mps += 0.38 / drive.gear; else drive.mps -= 0.55;
            if (mph > 150) drive.throttle = false;
            if (drive.mps <= 0) { drive.mps = 0; drive.throttle = true; }
            while (drive.gear < 6 && mph > GEAR_TOP[drive.gear]) drive.gear++;
            while (drive.gear > 1 && mph < GEAR_TOP[drive.gear - 1] - 6) drive.gear--;
            const lo = GEAR_TOP[drive.gear - 1], hi = GEAR_TOP[drive.gear];
            rpm = 0.11 + clamp01((mph - lo) / (hi - lo)) * (drive.throttle ? 0.82 : 0.6);
        } else {
            drive.mps = (60 + 40 * Math.sin(ts / 6)) / MPS_TO_MPH;               // kecepatan pelan naik-turun, RPM diatur skenario
            rpm = SCEN[sim.mode](ts);
        }
        drive.health = Math.max(180, drive.health - 0.9);
        if (drive.health <= 180) drive.health = 1000;
        drive.fuel = drive.fuel <= 4 ? 86 : drive.fuel - 0.02;
        drive.odo += (mph * 0.05) / 3600;

        api.setEngine(sim.mode !== 'off');
        api.setSpeed(sim.mode === 'off' ? 0 : drive.mps);
        api.setRPM(rpm);                                                         // undefined -> diabaikan (skenario "tidak ada data RPM")
        api.setGear(drive.gear);
        api.setHealth(drive.health);
        api.setFuel(drive.fuel);
        api.setOdometer(drive.odo);
        api.setHeadlights(Math.floor(drive.t / 9) % 3 === 2 ? 2 : 1);
        api.updateLockStatus(Math.floor(drive.t / 7) % 2);
    }
    sim.start = function (mode) {
        sim.mode = SCEN.hasOwnProperty(mode) ? mode : 'auto';
        sim.t0 = performance.now();
        if (!sim.running) {
            sim.running = true;
            api.setSeatbelts(true);
            sim.timer = setInterval(feed, 50);                                   // satu feeder data 20 Hz (meniru game); jarum tetap digerakkan loop rAF
        }
        syncPanel();
    };
    sim.stop = function () {
        if (!sim.running) return;
        sim.running = false;
        clearInterval(sim.timer);
        syncPanel();
    };
    onRealData = function () { if (sim.running) sim.stop(); };

    // ----- Panel uji (tombol skenario + readout limiter) -----
    const LABELS = { auto: 'Auto demo', idle: 'RPM rendah', slow: 'RPM naik pelan', fast: 'RPM naik cepat', high: 'RPM tinggi (bukan limiter)',
        limiter: 'Limiter tertahan', fluct: 'Fluktuasi di threshold', off: 'Mesin mati', nodata: 'Data RPM hilang' };
    const panel = document.createElement('div');
    panel.className = 'test-panel';
    panel.id = 'test-panel';
    const btns = {};
    Object.keys(LABELS).forEach((k) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = LABELS[k];
        b.addEventListener('click', () => sim.start(k));
        panel.appendChild(b); btns[k] = b;
    });
    const readout = document.createElement('div');
    readout.className = 'readout';
    panel.appendChild(readout);
    if (!params.has('nopanel')) document.body.appendChild(panel);
    function syncPanel() { Object.keys(btns).forEach((k) => btns[k].classList.toggle('on', sim.running && sim.mode === k)); }
    setInterval(() => {                                                          // hanya readout debug panel
        const d = window.hudDebug();
        readout.textContent = 'rpm ' + (d.rpmRatio * CFG.revLimit).toFixed(0) + '  limiter ' + (d.limiter.active ? 'ON ' : 'off') +
            '  getar ' + d.limiter.env.toFixed(2) + '  sudut ' + d.finalAngle.toFixed(1);
    }, 200);

    window.hudTest = { scenario: sim.start, stop: sim.stop, scenarios: Object.keys(SCEN) };
    const wanted = params.get('demo');
    setTimeout(() => { if (!sim.running) sim.start(wanted && SCEN.hasOwnProperty(wanted) ? wanted : 'auto'); }, 2800);   // setelah intro
}

})();
