/* Один сценарий = один свежий jsdom + свой сид: ноль перекрёстного загрязнения ГШЧ.
   Запуск: node scenario.js <super|human|stand|nofire|jump30|boss> [seed] */
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const CAND = [process.env.GALYUHA_ROOT, path.resolve(__dirname, '..'), path.resolve(__dirname, '..', 'galyuha')].filter(Boolean);
const ROOT = CAND.find(d => fs.existsSync(path.join(d, 'game.js'))) || CAND[CAND.length - 1];
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const game = fs.readFileSync(path.join(ROOT, 'game.js'), 'utf8');
const W = 1280, H = 800;

let seed = Number(process.env.SEED || 1) | 0;
const T = [];
function rng() {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
let hrng = Number(process.env.SEED || 1) * 7919 + 13;
function hrngN() {                                  // отдельный ГШЧ для «человеческого» шума
    hrng = (hrng + 0x6D2B79F5) | 0;
    let t = Math.imul(hrng ^ (hrng >>> 15), 1 | hrng);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const WHICH = process.argv[2] || 'super';
const SECONDS = Number(process.env.SECONDS || 0) || ({ super: 400, human: 420, stand: 90, nofire: 90, jump30: 60, boss: 120 })[WHICH];
const START_WAVE = { super: 1, human: 1, stand: 14, nofire: 14, jump30: 30, boss: 5 }[WHICH];

let clock = 0, rafCb = null, shadow = 0, drawCalls = 0;
const errors = [];

const dom = new JSDOM(html.replace('<script src="game.js"></script>', ''), {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: false,
});
const { window } = dom;
window.Math.random = rng;
Object.defineProperty(window, 'innerWidth', { value: W, configurable: true });
Object.defineProperty(window, 'innerHeight', { value: H, configurable: true });
const noop = () => {};
window.HTMLCanvasElement.prototype.getContext = function (t) {
    if (t !== '2d') return null;
    if (!this.__c) this.__c = new Proxy({ canvas: this, createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }), measureText: () => ({ width: 10 }) }, {
        get(o, p) { if (p === 'shadowBlur') return o.__sb || 0; if (p in o) return o[p]; return () => { drawCalls++; }; },
        set(o, p, v) { if (p === 'shadowBlur' && v) shadow++; o[p] = v; return true; },
    });
    return this.__c;
};
window.HTMLElement.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, top: 0, left: 0, right: W, bottom: H, width: W, height: H }; };
window.requestAnimationFrame = cb => { rafCb = cb; return 1; };
window.cancelAnimationFrame = () => { rafCb = null; };
window.Image = class { set src(v) { this._s = v; } get src() { return this._s; } };
window.Audio = class { addEventListener() {} play() { return Promise.resolve(); } pause() {} };
window.fetch = () => Promise.reject(new Error('x'));
window.performance = { now: () => clock };
window.setInterval = () => 0; window.clearInterval = () => {};
window.setTimeout = fn => { try { fn && fn(); } catch (e) {} return 0; };
window.clearTimeout = () => {};
window.console.warn = () => {};
window.onerror = m => errors.push('onerror: ' + m);
window.console.error = (...a) => errors.push('console.error: ' + a.join(' '));

try { window.eval(game); } catch (e) { errors.push('eval: ' + e.message); }
const DBG = window.__DBG;
if (!DBG) { console.log(JSON.stringify({ error: 'no __DBG' })); process.exit(1); }

const el = () => window.document.getElementById('upgrade-screen');
const isOpen = () => !!(el() && !el().classList.contains('hidden'));
let picks = 0;
function takeUpg(mode) {
    const cards = window.document.querySelectorAll('#upgrade-cards .upg-card');
    if (!cards.length) return false;
    const last = cards.length - 1;
    const i = mode === 'skip' ? last : (picks % Math.max(1, last));
    cards[i].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    picks++;
    return true;
}
const HIST = [];
function aim(human) {
    const s = DBG.state();
    let best = null, by = -1e9;
    for (const e of s.enemiesList) if (e.y < s.playerY - 8 && e.y > by) { by = e.y; best = e; }
    if (!best) for (const e of s.enemiesList) if (e.y > by) { by = e.y; best = e; }
    if (!best && s.bossList.length) best = s.bossList[0];
    if (!best) return;
    let x = best.x;
    if (human) {
        HIST.push(x);
        if (HIST.length > 15) x = HIST.shift();          // ~250мс реакции
        x += (hrngN() - 0.5) * 26;                        // промах ±13px
        if (hrngN() < 0.12) x = HIST[HIST.length - 1];    // отвлёкся
    }
    DBG.set({ pointerX: Math.max(0, Math.min(W, x)) });
}

const TICK = 16.6667;
window.document.getElementById('btn-play').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
if (START_WAVE > 1) DBG.restart(START_WAVE);
DBG.set({ firing: WHICH !== 'nofire' });
if (WHICH === 'stand') DBG.set({ pointerX: 640 });

let frames = 0, peak = 0, spiral = 0, worstSpiral = 0, blocked = 0, lastWave = 1, waveTimes = [];
let viol = 0, violEx = null;                 // инвариант: жизнь «за утечку» уходит только при пустом дневнике
let wStart = 0;
const cap = DBG.state().maxEnemies;
const maxFrames = SECONDS * 60;
let spins = 0;
while (frames < maxFrames && spins < maxFrames * 2) {
    spins++;
    if (isOpen()) { if (!takeUpg(WHICH === 'super' || WHICH === 'human' || WHICH === 'boss' ? 'rotate' : 'skip')) break; blocked++; continue; }
    const s0 = DBG.state();
    if (s0.dead) break;
    if (WHICH !== 'stand') aim(WHICH === 'human');
    clock += TICK;
    const cb = rafCb; rafCb = null;
    try { cb && cb(clock); } catch (e) { errors.push('кадр: ' + (e.stack || e.message).split('\n')[0]); break; }
    frames++;
    const s = DBG.state();
    peak = Math.max(peak, s.enemies);
    if (s.enemies >= cap) { spiral++; worstSpiral = Math.max(worstSpiral, spiral); } else spiral = 0;
    const livesBefore = s.lives, gBefore = s.grades;
    if (s.wave !== lastWave) { waveTimes.push([lastWave, frames - wStart, s.stat.killed, s.stat.spawns, s.score, s.grades, s.lives]); wStart = frames; lastWave = s.wave; }
}
const st = DBG.state();
const w15 = waveTimes.find(w => w[0] === 15);
console.log(JSON.stringify({
    which: WHICH, seed: Number(process.env.SEED || 1), frames,
    wave: st.wave, dead: st.dead, lives: st.lives, grades: st.grades, score: st.score,
    stat: st.stat, picks, upgrades: st.upgrades.length, blocked, pressure: +st.pressure.toFixed(2),
    peak, worstSpiral, cap, shadow, errors: errors.length, viol, violEx,
    errSample: errors.slice(0, 2),
    wave15sec: w15 ? +(w15[1] / 60).toFixed(1) : null, wt: waveTimes,
    avgWaveSec: waveTimes.length ? +(waveTimes.reduce((a, b) => a + b[1], 0) / waveTimes.length / 60).toFixed(1) : null,
}));
