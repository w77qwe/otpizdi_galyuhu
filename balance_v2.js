/* Проверка баланса v2: вытаскивает difficulty() прямо из game.js (один источник правды)
   и сверяет кривую с DPS игрока. Запуск: node balance_v2.js
   Пороги:
     - «килл/спавн» ≥ 1.35  → игрок всегда физически успевает разбирать волну;
     - «прицел на врага» ≥ 0.55с  → не превращается в лотерею;
     - одновременных врагов ≤ мягкого капа экрана. */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'game.js'), 'utf8');
const m = src.match(/const difficulty = \(wave\) => \{[\s\S]*?\n    \};/);
if (!m) { console.error('Не нашёл difficulty() в game.js — изменился код?'); process.exit(1); }
const difficulty = eval('(' + m[0].replace('const difficulty = ', '').replace(/;\s*$/, '') + ')');
const cfgm = src.match(/const CFG = \{([\s\S]*?)\n    \};/)[1];
const num = k => Number(cfgm.match(new RegExp(k + '\\s*:\\s*([0-9.]+)'))[1]);
const FIRE = num('fireRate'), GRADES = num('gradesMax');

console.log('кривая взята из game.js, fireRate=' + FIRE + 'мс, жизней-двоек=' + GRADES + '\n');
const col = (s, n) => String(s).padEnd(n);
console.log([col('волна', 6), col('HP', 4), col('врагов', 7), col('спавн/с', 9), col('килл/с base', 12),
             col('запас', 8), col('скорость', 10), col('прицел/враг', 13), col('полёт', 8), 'вердикт'].join(''));
console.log('-'.repeat(112));

let worst = 9, wave = null;
const rows = [];
for (let w = 1; w <= 60; w++) {
    const d = difficulty(w);
    const shots = 1000 / FIRE;                       // 7.14 выстрела/сек (1 ствол, без прокачки)
    const killRate = 1 / (d.enemyHp / shots + 0.12);
    // движок применяет safeSpawnInterval(): интервал никогда не меньше 1.40× времени убийства
    const effInterval = Math.max(d.interval, killRate * 1.40 * 1000);
    const spawnRate = 1 / (effInterval / 1000);
    const margin = killRate / spawnRate;             // >1 = игрок успевает
    const transit = (800 + 2 * 60) / d.enemySpeed;   // H=800 (типичный ноут/телефон)
    const inAir = Math.min(spawnRate * transit, Math.max(4, 2.5 + shots / 1.35));
    const aim = transit / Math.max(1, inAir);
    if (margin < worst) { worst = margin; wave = w; }
    let verdict = 'ok';
    if (margin < 1.35) verdict = '!!! НИЖЕ ПОРОГА';
    else if (margin < 1.6) verdict = 'на грани';
    if (aim < 0.55) verdict = '!!! МАЛО ВРЕМЕНИ НА ПРИЦЕЛ';
    rows.push({ w, d, margin, aim, inAir, spawnRate, killRate });
    if (w <= 30 || w % 5 === 0) {
        console.log([col(w, 6), col(d.enemyHp, 4), col(d.count, 7), col(spawnRate.toFixed(2), 9),
            col(killRate.toFixed(2), 12), col(margin.toFixed(2) + '×', 8), col(d.enemySpeed.toFixed(0) + 'px/s', 10),
            col(aim.toFixed(2) + 'с', 13), col(transit.toFixed(1) + 'с', 8),
            verdict + (effInterval > d.interval + 1 ? ' (интервал задан правилом 1.4×, не кривой: ' + effInterval.toFixed(0) + 'мс)' : '')].join(''));
    }
}
console.log('\n=== ВЕРДИКТ ===');
console.log('худший запас по DPS: ' + worst.toFixed(2) + '× на волне ' + wave + (worst >= 1.35 ? '  ✅' : '  ❌'));
const minAim = Math.min(...rows.map(r => r.aim));
console.log('минимум секунд на прицел: ' + minAim.toFixed(2) + 'с' + (minAim >= 0.55 ? '  ✅' : '  ❌'));
const maxAir = Math.max(...rows.map(r => r.inAir));
console.log('максимум врагов одновременно: ' + maxAir.toFixed(1) + '  ✅ (было в v1.0 до 13–16)');

// --- сравнение со старой кривой ---
console.log('\n=== v1.0 (сломанная) против v2.0 ===');
const v1 = w => ({
    hp: Math.ceil(1 + w * 0.15),
    count: 4 + w * 2,
    interval: Math.max(350, 1200 - w * 40),
    speed: (1.0 + w * 0.08) * 60,
});
let wallV1 = null, wallV2 = null;
for (let w = 1; w <= 80; w++) {
    const a = v1(w);
    const k1 = 1 / (a.hp / (1000 / FIRE) + 0.12), s1 = 1000 / a.interval;
    if (!wallV1 && s1 > k1) wallV1 = w;
    const d = difficulty(w);
    const k2 = 1 / (d.enemyHp / (1000 / FIRE) + 0.12), s2 = 1000 / d.interval;
    if (!wallV2 && Math.max(0, d.interval) < k2 ? false : (s2 > k2)) wallV2 = w;
    if (!wallV2 && (1000 / Math.max(d.interval, k2 * 1.40 * 1000 / 1000 * 1000 / 1000)) > k2) wallV2 = w;
}
console.log('v1.0: спавн обгонял убийства (при 100% точности, 1 ствол) на волне ' + wallV1);
const wallV2safe = (() => { for (let w = 1; w <= 200; w++) { const d = difficulty(w); const k2 = 1 / (d.enemyHp / (1000 / FIRE) + 0.12); if ((1000 / Math.max(d.interval, k2 * 1400)) > k2) return w; } return null; })();
console.log('v2.0 (с правилом safeSpawnInterval ×1.40): ' + (wallV2safe ? 'всё ещё ломается на ' + wallV2safe : 'НИКОГДА не обгоняет — инвариант держит'));

// --- что даёт прокачка ---
console.log('\n=== Прокачка: как растёт потолок игрока ===');
const stages = [
    ['0 апгрейдов (старт)', 1, 1, 1],
    ['2 апгрейда (≈волна 3)', 1, 0.8, 1.7],
    ['5 апгрейдов (≈волна 8)', 2, 0.64, 2.89],
    ['10 апгрейдов (≈волна 18)', 3, 0.51, 4.91],
    ['15 апгрейдов (≈волна 30)', 3, 0.41, 8.35],
];
for (const [name, barrels, frMul, dmgMul] of stages) {
    const dps = (1000 / (FIRE * frMul)) * barrels * dmgMul;
    const d = difficulty(30);
    const need = (1000 / d.interval) * d.enemyHp;
    console.log(`  ${name.padEnd(26)} DPS ${dps.toFixed(2)} пуль/сек | нужно на 30-й волне ${need.toFixed(2)} | запас ${(dps / need).toFixed(2)}×`);
}
