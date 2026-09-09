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
const D = window.document, DBG = window.__DBG;
const vis = id => { const e = D.getElementById(id); return !!e && (e.id === 'game-ui' ? true : !e.classList.contains('hidden')); };
const click = id => { const e = D.getElementById(id); if (!e) return 'NO_ID:' + id; e.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); return 'ok'; };
const UPG = () => D.getElementById('upgrade-screen');
const out = { errors: errors.slice(0, 6) };
// 1) стартовый экран и все обязательные ноды
const NEED = ['gameCanvas','menu-screen','game-screen','gameover-screen','hud','score','wave','grades-display','grades','cheat-display','cheat-charges','lives','banner','upgrade-screen','upgrade-cards','gameover-subtitle','final-upgrades','final-wave','final-score','btn-play','btn-restart','btn-menu','btn-sound'];
out.missing = NEED.filter(id => !D.getElementById(id));
// 2) клик по меню: старт -> идёт игра
out.start = click('btn-play');
for (let i = 0; i < 40; i++) rafCb && rafCb(clock += 16.7);
out.afterStart = { menuHidden: D.getElementById('menu-screen').classList.contains('hidden'), gameShown: !D.getElementById('game-screen').classList.contains('hidden'), wave: DBG.state().wave };
// 3) HUD обновляется (текст, а не только переменные движка)
out.hud = { wave: D.getElementById('wave').textContent, score: D.getElementById('score').textContent, grades: D.getElementById('grades').textContent, cheat: D.getElementById('cheat-charges').textContent };
// 4) экран апгрейдов открывается и карточки кликабельны
DBG.killAllEnemies();
for (let i = 0; i < 400 && UPG().classList.contains('hidden'); i++) rafCb && rafCb(clock += 16.7);
out.pickerShown = !UPG().classList.contains('hidden');
out.cards = D.querySelectorAll('#upgrade-cards .upg-card').length;
const c0 = D.querySelector('#upgrade-cards .upg-card');
if (c0) { c0.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); }
out.pickerClosed = !!UPG().classList.contains('hidden');
out.upgrades = Object.keys(DBG.state().upgrades || {}).length;
// 5) классы состояний HUD: .low на #grades-display при 1 двойке, .ready на #cheat-display при зарядах
DBG.pickUpgrade('cheat');                      // зачётка -> .ready
DBG.setGrades(1);                              // мало двоек -> .low (сразу, до рефилла волны)
for (let i = 0; i < 60; i++) rafCb && rafCb(clock += 16.7);
const gd = D.getElementById('grades-display'), cd = D.getElementById('cheat-display');
out.hudClasses = { grades: D.getElementById('grades').textContent, gradesCls: [...gd.classList].join(' '), cheat: D.getElementById('cheat-charges').textContent, cheatCls: [...cd.classList].join(' ') };
// 6) пауза: канвас не перерисовывается (логика и рендер заморожены)
const key = code => window.dispatchEvent(new window.KeyboardEvent('keydown', { code, key: code, bubbles: true }));
const before = drawCalls; key('KeyP');
for (let i = 0; i < 20; i++) rafCb && rafCb(clock += 16.7);
out.pausedState = DBG.state().paused; out.pauseStopsDraw = (drawCalls - before) === 0; key('KeyP');
// 7) game over по принуждению: экран, подзаголовок, статистика
DBG.restart(4);
for (let i = 0; i < 120; i++) { clock += 900; DBG.clearIfr(); DBG.hit(); rafCb && rafCb(clock += 16.7); }
for (let i = 0; i < 60; i++) rafCb && rafCb(clock += 16.7);
out.gameover = { shown: !D.getElementById('gameover-screen').classList.contains('hidden'), gameHidden: D.getElementById('game-screen').classList.contains('hidden'), sub: (D.getElementById('gameover-subtitle')||{}).textContent, finalWave: (D.getElementById('final-wave')||{}).textContent, upg: (D.getElementById('final-upgrades')||{}).textContent };
// 8) рестарт из game over
out.restart = click('btn-restart');
for (let i = 0; i < 20; i++) rafCb && rafCb(clock += 16.7);
out.afterRestart = DBG.state().wave;
out.errorsFinal = errors.length;
console.log(JSON.stringify(out, null, 1));
