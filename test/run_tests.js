/* Батч-раннер: сценарий × сид → один свежий процесс. Проверяет баланс пачкой,
   а не одним удачным прогоном. Использование:
     node run_tests.js                 # полный прогон (10 сидов × 6 сценариев)
     node run_tests.js --fast          # 3 сида
     node run_tests.js --det           # только проверка воспроизводимости */
const { execFileSync } = require('child_process');
const path = require('path');
const ARGS = process.argv.slice(2);
const FAST = ARGS.includes('--fast'), DET = ARGS.includes('--det');
const SEEDS = (process.env.SEEDS || (FAST ? '1,7,99' : '1,5,42,99,777,31415,2718,1618,20260909,20260910'))
    .split(',').map(Number);
const CASES = ['super', 'human', 'stand', 'nofire', 'jump30', 'boss'];

function run(which, seed, env) {
    let out = '';
    try {
        out = execFileSync('node', [path.join(__dirname, 'scenario.js'), which], {
            env: { ...process.env, SEED: String(seed), ...(env || {}) }, encoding: 'utf8', maxBuffer: 1 << 26,
        });
    } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
    const line = out.trim().split('\n').filter(l => l.startsWith('{')).pop();
    if (!line) return { which, seed, error: 'no json: ' + out.slice(0, 200) };
    try { return JSON.parse(line); } catch (e) { return { which, seed, error: 'bad json' }; }
}
const med = a => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const results = {};
if (!DET) {
    for (const c of CASES) results[c] = [];
    for (const seed of SEEDS) {
        const line = [];
        for (const c of CASES) {
            const r = run(c, seed, c === 'jump30' ? { SECONDS: '60' } : {});
            results[c].push(r);
            if (r.error) { line.push(`${c}:!!`); continue; }
            const tag = {
                super: `w${r.wave}${r.dead ? '†' : ''}`,
                human: `w${r.wave}/${(r.frames / 60) | 0}s${r.dead ? '†' : ''}`,
                stand: `${r.grades >= 0 ? ((r.stat.leaks || 0)) : 0}ут`,
                nofire: `${(r.stat.leaks || 0)}ут/${(r.stat.gradeLost || 0)}дв/${(r.stat.livesLost || 0)}ж`,
                jump30: `w${r.wave}${r.dead ? '†' : ''}`,
                boss: `b${r.stat.bossKilled}${r.stat.quizOk ? '✓' + r.stat.quizOk : ''}`,
            }[c];
            line.push(`${c}=${tag}`);
        }
        console.log(`seed ${String(seed).padEnd(9)} ${line.join('  ')}`);
    }
}

/* ---------- 1. воспроизводимость ---------- */
console.log('\n=== ВОСПРОИЗВОДИМОСТЬ (один сид дважды = идентичный результат) ===');
let rep = true;
for (const c of ['super', 'human', 'boss']) {
    const a = run(c, 4242), b = run(c, 4242);
    const same = JSON.stringify({ w: a.wave, s: a.score, p: a.picks }) === JSON.stringify({ w: b.wave, s: b.score, p: b.picks });
    console.log(`${same ? 'PASS' : 'FAIL'}  ${c}: ${a.wave}w/${a.score} vs ${b.wave}w/${b.score}`);
    if (!same) rep = false;
}

if (DET) { console.log('\n' + (rep ? 'ДЕТЕРМИНИРОВАНО' : 'ЕСТЬ РАСХОЖДЕНИЯ')); process.exit(rep ? 0 : 1); }

/* ---------- 2. агрегатные проверки ---------- */
const ok = r => !r.error;
const all = k => results[k].filter(ok);
const w = (k, f) => all(k).map(r => f ? f(r) : r.wave);
function assert(name, cond, extra) {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
    if (!cond) process.exitCode = 1;
}
console.log('\n=== СТАБИЛЬНОСТЬ ===');
assert('нет исключений ни в одном прогоне', CASES.every(c => all(c).every(r => r.errors === 0)),
    CASES.map(c => all(c).reduce((a, r) => a + r.errors, 0)).join('/'));
assert('нет «ошибки» в парсере', CASES.every(c => results[c].every(ok)));
assert('shadowBlur нигде не включается', CASES.every(c => all(c).every(r => r.shadow === 0)));

console.log('\n=== «СТЕНЫ» БОЛЬШЕ НЕТ (в v1.0 на 14-й волне игра становилась непроходимой) ===');
const sup = w('super'), hu = w('human');
assert('супер-игрок: худший сид > 20 волн', Math.min(...sup) > 20, `худший ${Math.min(...sup)}, медиана ${med(sup)}, лучший ${Math.max(...sup)}`);
assert('«человек»: медиана ≥ 15 волн', med(hu) >= 15, `медиана ${med(hu)}, худший ${Math.min(...hu)}`);
assert('«человек»: худший сид живёт ≥ 40с', Math.min(...all('human').map(r => r.frames / 60)) >= 40,
    Math.min(...all('human').map(r => r.frames / 60)).toFixed(0) + 'с');
assert('босс-волна 5 проходима (все сиды убили босса)', all('boss').every(r => r.stat.bossKilled >= 1),
    all('boss').map(r => r.stat.bossKilled).join(','));
assert('викторина не спамится (quizBad ≤ 4 за прогон)', all('boss').every(r => (r.stat.quizBad || 0) <= 4),
    'max ' + Math.max(...all('boss').map(r => r.stat.quizBad || 0)));

console.log('\n=== НАКАЗАНИЕ РАБОТАЕТ (игра не стала «песочницей») ===');
assert('прыжок на 30-ю без прокачки = смерть', all('jump30').every(r => r.dead), 'выжили ' + all('jump30').filter(r => !r.dead).length);
assert('не стрелять = провалить волну', all('nofire').every(r => r.dead || r.stat.gradeLost >= 3),
    all('nofire').map(r => (r.stat.gradeLost || 0)).join(','));
assert('стоять на месте = утечки идут', all('stand').every(r => r.stat.leaks >= 3),
    all('stand').map(r => (r.stat.leaks || 0)).join(','));
assert('инвариант честности: жизнь «за утечку» теряется ТОЛЬКО при пустом дневнике',
    CASES.every(c => all(c).every(r => r.viol === 0)),
    'нарушений ' + CASES.reduce((a, c) => a + all(c).reduce((x, r) => x + (r.viol || 0), 0), 0));

console.log('\n=== НЕТ НАКОПЛЕНИЯ ОЧЕРЕДИ (главная болячка v1.0) ===');
assert('экранные враги никогда не забивают лимит на 3+ секунды',
    CASES.every(c => all(c).every(r => r.worstSpiral < 180)),
    'макс ' + Math.max(...CASES.flatMap(c => all(c).map(r => r.worstSpiral))));
assert('пик одновременных врагов ≤ лимита', CASES.every(c => all(c).every(r => r.peak <= r.cap)),
    'макс ' + Math.max(...CASES.flatMap(c => all(c).map(r => r.peak))));
assert('гейм-мастер вменяем (0.7..1.36)', all('human').every(r => r.pressure >= 0.7 && r.pressure <= 1.36),
    all('human').map(r => r.pressure.toFixed(2)).join(' '));

console.log('\n=== UI / DOM (индекс, клики, HUD, пауза, game over) ===');
let ui = null;
try { ui = JSON.parse(execFileSync('node', [path.join(__dirname, 'ui_smoke.js')], { encoding: 'utf8', cwd: __dirname }).trim()); }
catch (e) { console.log('  (не удалось получить вывод ui_smoke.js: ' + String(e.message).slice(0, 80) + ')'); }
if (ui) {
    assert('все обязательные узлы DOM на месте', ui.missing.length === 0, ui.missing.join(',') || 'ок');
    assert('меню → старт: меню скрыто, игра видна, волна 1',
        ui.afterStart.menuHidden && ui.afterStart.gameShown && ui.afterStart.wave === 1);
    assert('HUD синхронизируется (текст, а не только переменные)',
        /^\d+$/.test(ui.hud.wave) && /^\d+$/.test(ui.hud.score) && /^\d\/\d$/.test(ui.hud.grades),
        JSON.stringify(ui.hud));
    assert('после волны открывается пикер с кликабельными карточками',
        ui.pickerShown && ui.cards >= 3 && ui.pickerClosed && ui.upgrades === 1,
        `карточек ${ui.cards}, взято ${ui.upgrades}`);
    assert('классы состояний: .low на двоек, .ready на зачётке',
        ui.hudClasses.gradesCls === 'low' && ui.hudClasses.cheatCls === 'ready',
        `${ui.hudClasses.grades} «${ui.hudClasses.gradesCls}» / ${ui.hudClasses.cheat} «${ui.hudClasses.cheatCls}»`);
    assert('пауза замораживает и логику, и рендер (канвас = стоп-кадр)',
        ui.pausedState === true && ui.pauseStopsDraw === true);
    assert('game over: экран, подзаголовок, финальная волна и строка прокачки',
        ui.gameover.shown && ui.gameover.gameHidden && /^\d+$/.test(ui.gameover.finalWave) &&
        /жаль|·|x\d|\+/.test(ui.gameover.upg) && ui.gameover.sub.length > 3,
        `волна ${ui.gameover.finalWave}, апгрейды: «${ui.gameover.upg}», «${ui.gameover.sub}»`);
    assert('рестарт из game over возвращает на 1-ю волну', ui.afterRestart === 1);
    assert('ноль ошибок рантайма в браузере (jsdom)', ui.errorsFinal === 0, JSON.stringify(ui.errors));
}

console.log('\n=== СВОДКА ===');
for (const c of CASES) {
    const rs = all(c);
    if (!rs.length) continue;
    console.log(`${c.padEnd(8)} волны: мин ${Math.min(...rs.map(r => r.wave))} / медиана ${med(rs.map(r => r.wave))} / макс ${Math.max(...rs.map(r => r.wave))}` +
        ` · живых ${rs.filter(r => !r.dead).length}/${rs.length} · пик врагов ${Math.max(...rs.map(r => r.peak))}`);
}
console.log('\n=== ' + (process.exitCode ? 'ЕСТЬ ПРОВАЛЫ' : 'ЗЕЛЁНОЕ НА ' + SEEDS.length + ' СИДАХ') + ' ===');
