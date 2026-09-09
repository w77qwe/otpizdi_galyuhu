/* ==============================================================
   СИМУЛЯТОР: ОТПИЗДИ ГАЛЮХУ  —  v2.0 "Зачётная сборка"
   Autistic Games | ВайкокинStar Games
   --------------------------------------------------------------
   Что изменилось по сравнению с v1.0 (см. DESIGN.md):
   - физика в px/сек, а не px/кадр → одинаково на 60 и 144 Гц
   - DPR-aware канвас (чётко на retina/телефоне)
   - потолок сложности: волна 30 не делает игру невозможной
   - пропуск врага ≠ мгновенная потеря жизни (введена шкала двоек)
   - прокачка: 1 из 3 апгрейдов после каждой волны
   - босс: телеграфы, паттерны, викторина «задача на доске»
   - glow-предрендер вместо shadowBlur на каждом объекте
   - пулы + swap-pop вместо splice, squared-distance коллизии
   - процедурный фоллбек-арт, если спрайты не загрузились
   - процедурная музыка на WebAudio, если crystals.mp3 нет
   ============================================================== */

(function () {
    'use strict';

    // ================= DOM =================
    const $ = id => document.getElementById(id);
    const menuScreen = $('menu-screen');
    const gameScreen = $('game-screen');
    const overScreen = $('gameover-screen');
    const canvas     = $('gameCanvas');
    const ctx        = canvas.getContext('2d', { alpha: false });
    const elScore    = $('score');
    const elLives    = $('lives');
    const elWave     = $('wave');
    const elGrades   = $('grades');
    const elCheat    = $('cheat-charges');
    const elFinalScore = $('final-score');
    const elFinalWave  = $('final-wave');
    const elFinalUpg   = $('final-upgrades');
    const pickerScreen = $('upgrade-screen');
    const pickerCards  = $('upgrade-cards');
    const banner       = $('banner');
    const btnPlay    = $('btn-play');
    const btnRestart = $('btn-restart');
    const btnMenu    = $('btn-menu');
    const btnSound   = $('btn-sound');

    // ================= КОНСТАНТЫ =================
    // Всё в логических пикселях в СЕКУНДУ (v1.0 считала в кадр — отсюда и FPS-баг).
    const CFG = {
        playerSpeed   : 560,      // px/сек (было 7 px/кадр = 420 px/сек на 60Hz)
        mouseSpeedMul : 1.9,      // мышью рулим быстрее, чем клавами: иначе не успевать за спавном у краёв
        aimAssist     : 0.55,     // 0..1: насколько пули «ведутся» на курсор (прицел ≠ позиционирование)
        mouseFollow   : 1,        // 1 = корабль строго под курсором (было lerp 0.14 — вечно опаздывал)
        bulletSpeed   : 1000,     // px/сек
        bulletSize    : 5,
        fireRate      : 140,      // мс между выстрелами (стартовый)
        bulletDamage  : 1,
        lives         : 3,
        gradesMax     : 6,        // «двойки в дневнике»: улетела Галюха -> минус двойка
        gradeRefundKills: 8,      // каждые N убийств возвращают 1 двойку
        invincTime    : 1300,     // мс неуязвимости после урона
        wavePause     : 1500,     // мс между волнами (там же окно апгрейда)
        bossEvery     : 5,
        quizTime      : 7000,     // мс на решение задачи (за это время босс стоит смирно)
        quizCooldown  : 5000,     // мс паузы после просроченной/неверной задачи
        cheatCooldown : 22000,    // мс перезарядки «Зачётки»
        cheatCharges  : 1,
        maxParticles  : 260,
        maxEnemies    : 34,
    };

    // ---- КРИВАЯ СЛОЖНОСТИ -------------------------------------------------
    // В v1.0: toSpawn = 4 + wave*2, spawnInterval = max(350, 1200 - wave*40),
    //          enemyHp = ceil(1 + wave*0.15)  →  спавн обгонял DPS игрока на волне 14.
    // Здесь рост ограничен плато, а плато наступает после того, как игрок обязан
    // получить 3-5 апгрейдов. Проверить: node balance.js
    // Базовая кривая до 25-й волны, после — медленный «endless»-рост (не экспонента!).
    // Плюс динамическая подстройка: gameMaster() смотрит, как играет конкретный игрок,
    // и удерживает давление ~на его потолке. Именно это даёт «интересно, но не невозможно».
    const difficulty = (wave) => {
        const t = Math.min(wave - 1, 24) / 24;
        const ex = Math.max(0, wave - 25);                 // endless-хвост
        return {
            enemyHp   : 1 + Math.floor(Math.min(wave - 1, 45) * 0.1),     // 1..5
            enemySpeed: 150 + 130 * t + ex * 0.9,                          // 280 → +0.9px/с за волну
            count     : 5 + Math.round(13 * t),                             // 5..18 (дальше решает gameMaster)
            interval  : 1150 - 500 * t,                                     // 1150 → 650 мс
            diveSpeed : 420 + 180 * t + ex * 1.5,
            swarm     : 0.45 * Math.max(t, ex * 0.02),
            elite     : Math.min(0.2, Math.max(0, wave - 13) * 0.012),      // шанс «отличницы» с ×2 HP
            extra     : ex > 0 ? Math.floor(ex / 12) : 0,                   // доп. снаряды у стреляков
        };
    };
    const KILL_TIME_PER_ENEMY = 0.12;   // сек на перенос прицела (для проверки баланса)

    // ═══ ГЛАВНОЕ ПРАВИЛО БАЛАНСА (инвариант движка) ═══
    // Интервал спавна ВСЕГДА считается из реального DPS игрока, а не из номера волны.
    // 40% запас означает: очередь врагов физически не может расти быстрее, чем
    // игрок её разбирает → «невозможная волна» невозможна по построению.
    const DPS_MARGIN = 1.40;
    function safeSpawnInterval(enemyHp, baseInterval) {
        const shotsPerSec = 1000 / (CFG.fireRate * upgrades.fireRateMul);
        const bullets = upgrades.barrels + upgrades.sideGuns * 2;
        const dps = (shotsPerSec * bullets * upgrades.damageMul) / enemyHp;   // врагов/сек
        const killRate = 1 / (1 / dps + KILL_TIME_PER_ENEMY);
        return Math.max(300, Math.min(1600, Math.max(baseInterval, killRate * DPS_MARGIN * 1000)));
    }

    // ================= СОСТОЯНИЕ =================
    let W = 0, H = 0, DPR = 1;
    let score = 0, lives = 0, wave = 1, grades = 0;
    let running = false, paused = false, dead = false;
    let gameTime = 0;                             // игровые мс (не wall-clock!): анимации не зависят от реального времени
    let animId = 0, lastTime = 0;

    let player = null;
    let bullets = [], enemies = [], ebullets = [], particles = [], floatTexts = [], stars = [], bubbles = [];
    let toSpawn = 0, spawnTimer = 0, spawnInterval = 1000;
    let waveState = 'active', wavePauseTimer = 0;
    let boss = null, bossWarned = false;
    let killsSinceRefund = 0, totalKills = 0;
    let stat = { leaks: 0, bodyHits: 0, doubleHits: 0, livesLost: 0, gradeLost: 0, gradeRefunded: 0,
                 spawns: 0, killed: 0, bossKilled: 0, quizOk: 0, quizBad: 0, cheat: 0 };
    let upgrades = null, upgradeQueue = [];
    let shake = { x: 0, y: 0, amt: 0, dur: 0 };
    let flash = 0;                 // красная вспышка при уроне
    let slowmo = 0;                // мс слоу-мо после убийства босса

    const keys = {};
    let pointerX = null, pointerActive = false, firing = false, fireTimer = 0;

    // ================= РЕСАЙЗ / DPR =================
    function resize() {
        DPR = Math.min(2, window.devicePixelRatio || 1);
        const rect = canvas.getBoundingClientRect();
        W = Math.max(320, Math.round(rect.width  || window.innerWidth));
        H = Math.max(320, Math.round(rect.height || window.innerHeight));
        canvas.width  = Math.round(W * DPR);
        canvas.height = Math.round(H * DPR);
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        if (player) player.y = H - 100;
        if (stars.length) initStars();
    }
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 200));

    function showScreen(el) {
        [menuScreen, gameScreen, overScreen, pickerScreen].forEach(s => s && s.classList.add('hidden'));
        if (el) el.classList.remove('hidden');
    }

    // ============================================================
    //  ЗВУК
    // ============================================================
    const ASSETS = {
        imgs: ['shit1.png', 'shit2.png', 'shit3.png', 'shit4.png'],
        boss: 'shit_final.png',
        music: 'crystals.mp3',
        sfx: {
            kill: 'snd_kill.mp3', playerHit: 'snd_player_hit.mp3',
            bossWarn: 'snd_boss_warn.mp3', bossKill: 'snd_boss_kill.mp3',
            gameover: 'snd_gameover.mp3',
        },
    };

    let actx = null, masterGain = null, muted = false, audioReady = false;
    const sfxBuffers = {};
    let musicMode = 'none';               // 'file' | 'synth' | 'none'
    let musicEl = null;
    const musicGain = { value: 0 };

    function initAudio() {
        if (actx) return;
        try {
            actx = new (window.AudioContext || window.webkitAudioContext)();
            masterGain = actx.createGain();
            masterGain.gain.value = muted ? 0 : 0.9;
            masterGain.connect(actx.destination);
            loadSfx();
            setupMusic();
            audioReady = true;
        } catch (e) { /* звук не критичен */ }
    }

    function loadSfx() {
        Object.entries(ASSETS.sfx).forEach(([key, url]) => {
            fetch(url).then(r => {
                if (!r.ok) throw 0;
                return r.arrayBuffer().then(b => actx.decodeAudioData(b)).then(dec => { sfxBuffers[key] = dec; });
            }).catch(() => { /* тишина — ок, у нас есть синты */ });
        });
    }

    function playSfx(name, vol) {
        if (!actx || muted) return;
        const buf = sfxBuffers[name];
        if (!buf) {                                  // файла нет → синтезируем похожее
            synthFallback(name);
            return;
        }
        const src = actx.createBufferSource();
        const g = actx.createGain();
        src.buffer = buf;
        g.gain.value = vol == null ? 0.5 : vol;
        src.connect(g); g.connect(masterGain);
        src.start(0);
    }

    function tone(type, f0, f1, dur, vol, delay) {
        if (!actx || muted) return;
        const t = actx.currentTime + (delay || 0);
        const o = actx.createOscillator();
        const g = actx.createGain();
        o.type = type;
        o.frequency.setValueAtTime(f0, t);
        if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
        o.connect(g); g.connect(masterGain);
        o.start(t); o.stop(t + dur + 0.02);
    }

    function noise(dur, vol, freq) {
        if (!actx || muted) return;
        const t = actx.currentTime;
        const n = Math.floor(actx.sampleRate * dur);
        const buf = actx.createBuffer(1, n, actx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
        const src = actx.createBufferSource();
        const filt = actx.createBiquadFilter();
        const g = actx.createGain();
        src.buffer = buf;
        filt.type = 'bandpass'; filt.frequency.value = freq || 900; filt.Q.value = 0.8;
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        src.connect(filt); filt.connect(g); g.connect(masterGain);
        src.start(t);
    }

    function synthShoot()   { tone('square', 900, 260, 0.07, 0.045); }
    function synthHit()     { tone('sine', 640, 220, 0.06, 0.06); }
    function synthKill()    { noise(0.22, 0.18, 500); tone('sawtooth', 300, 60, 0.2, 0.07); }
    function synthHurt()    { tone('sawtooth', 220, 55, 0.3, 0.12); noise(0.3, 0.12, 200); }
    function synthWave()    { tone('sine', 440, 880, 0.25, 0.07); }
    function synthDone()    { [523, 659, 784, 1046].forEach((f, i) => tone('sine', f, f, 0.22, 0.07, i * 0.09)); }
    function synthBossWarn(){ tone('square', 140, 140, 0.5, 0.1); tone('square', 110, 110, 0.5, 0.1, 0.5); noise(0.8, 0.08, 120); }
    function synthBossKill(){ [200, 160, 130, 100, 80].forEach((f, i) => tone('sawtooth', f, f * 0.5, 0.4, 0.09, i * 0.08)); noise(1.2, 0.2, 260); }
    function synthUpgrade() { [660, 880, 1320].forEach((f, i) => tone('triangle', f, f, 0.16, 0.08, i * 0.07)); }
    function synthCheat()   { tone('sawtooth', 1200, 100, 0.5, 0.1); noise(0.5, 0.14, 700); }
    function synthQuiz(ok)  { if (ok) [700, 1050].forEach((f, i) => tone('sine', f, f, 0.16, 0.08, i * 0.1)); else tone('square', 200, 90, 0.3, 0.1); }

    function synthFallback(name) {
        ({ kill: synthKill, playerHit: synthHurt, bossWarn: synthBossWarn,
           bossKill: synthBossKill, gameover: synthHurt })[name] &&
        ({ kill: synthKill, playerHit: synthHurt, bossWarn: synthBossWarn,
           bossKill: synthBossKill, gameover: synthHurt })[name]();
    }

    // ---- музыка: сначала файл, если его нет — процедурный эмбиент ----
    function setupMusic() {
        musicEl = new Audio();
        musicEl.src = ASSETS.music;
        musicEl.loop = true;
        musicEl.volume = 0.35;
        musicEl.addEventListener('error', () => { if (musicMode !== 'file') startSynthMusic(); });
        musicEl.play().then(() => { musicMode = 'file'; musicEl.pause(); musicEl.currentTime = 0; })
                     .catch(() => { musicMode = 'synth'; });
        if (musicMode === 'synth') startSynthMusic();
    }

    const CHORDS = [
        { root: 110, notes: [220, 261.6, 329.6, 392.0] },   // Am
        { root:  87.3, notes: [174.6, 220, 261.6, 349.2] }, // F
        { root:  98.0, notes: [196.0, 246.9, 293.7, 392.0] },// G
        { root:  82.4, notes: [164.8, 207.7, 246.9, 329.6] },// E
    ];
    let musicTimer = 0, musicStep = 0, musicChord = 0;

    function startSynthMusic() {
        if (!actx || musicMode === 'file') return;
        musicMode = 'synth';
        musicStep = 0; musicChord = 0;
        clearInterval(musicTimer);
        musicTimer = setInterval(stepSynthMusic, 250);
    }

    function stepSynthMusic() {
        if (!actx || muted || musicMode !== 'synth' || !running || paused) return;
        const c = CHORDS[musicChord % CHORDS.length];
        const s = musicStep % 8;
        if (s === 0) {                                       // бас
            tone('sine', c.root, c.root, 1.9, 0.10);
            tone('triangle', c.root * 2, c.root * 2, 1.6, 0.03);
        }
        if (s === 0 || s === 3 || s === 5) {                 // пэд-перебор
            const f = c.notes[(musicStep + s) % c.notes.length];
            tone('triangle', f, f, 1.1, 0.028);
            tone('sine', f * 2, f * 2, 0.7, 0.012);
        }
        if (s === 2 || s === 6) tone('sine', c.notes[3] * 2, c.notes[3] * 2, 0.4, 0.018);
        musicStep++;
        if (musicStep % 8 === 0) musicChord++;
    }

    function startMusic() {
        if (musicMode === 'file' && musicEl) { musicEl.currentTime = 0; musicEl.play().catch(() => {}); }
    }
    function stopMusic() { if (musicEl) musicEl.pause(); }

    function toggleMute() {
        muted = !muted;
        if (masterGain) masterGain.gain.value = muted ? 0 : 0.9;
        if (musicEl) musicEl.muted = muted;
        if (btnSound) btnSound.textContent = muted ? '🔇' : '🔊';
        try { localStorage.setItem('galyuha_muted', muted ? '1' : '0'); } catch (e) {}
    }
    try { muted = localStorage.getItem('galyuha_muted') === '1'; } catch (e) {}
    document.addEventListener('click',  () => initAudio(), { once: true });
    document.addEventListener('touchstart', () => initAudio(), { once: true, passive: true });

    // ============================================================
    //  ЗВЁЗДЫ (3 параллакс-слоя, без shadowBlur)
    // ============================================================
    function initStars() {
        stars = [];
        const n = Math.round((W * H) / 11000);
        for (let i = 0; i < Math.min(240, n); i++) {
            const layer = i % 3;
            stars.push({
                x: Math.random() * W, y: Math.random() * H,
                r: 0.4 + layer * 0.55 + Math.random() * 0.5,
                sp: (18 + layer * 26) + Math.random() * 14,
                a: 0.25 + layer * 0.22 + Math.random() * 0.2,
            });
        }
    }
    function updateStars(dt) {
        const s = dt / 1000;
        for (const st of stars) {
            st.y += st.sp * s;
            if (st.y > H) { st.y = -2; st.x = Math.random() * W; }
        }
    }
    function drawStars() {
        for (const st of stars) {
            ctx.globalAlpha = st.a;
            ctx.fillStyle = '#cfe6ff';
            ctx.fillRect(st.x, st.y, st.r, st.r);
        }
        ctx.globalAlpha = 1;
    }

    // ============================================================
    //  ГЛОУ-ПРЕДРЕНДЕР (главная оптимизация)
    //  В v1.0 на КАЖДУЮ пулю/частицу/текст вешался ctx.shadowBlur —
    //  это самый дорогой фильтр канваса. Теперь свечение запечено в спрайт 1 раз.
    // ============================================================
    const GLOW = {};
    function makeGlow(name, w, h, drawFn) {
        const c = document.createElement('canvas');
        c.width = Math.ceil(w); c.height = Math.ceil(h);
        const g = c.getContext('2d');
        drawFn(g, c.width, c.height);
        GLOW[name] = c;
        return c;
    }
    function buildGlowSprites() {
        makeGlow('bullet', 20, 40, (g, w, h) => {
            const grd = g.createLinearGradient(0, 0, 0, h);
            grd.addColorStop(0, 'rgba(255,255,255,1)');
            grd.addColorStop(0.45, 'rgba(90,230,255,0.95)');
            grd.addColorStop(1, 'rgba(20,120,255,0)');
            g.fillStyle = grd;
            g.beginPath(); g.ellipse(w / 2, h / 2, 3.2, h / 2, 0, 0, Math.PI * 2); g.fill();
            g.globalAlpha = 0.35; g.fillStyle = '#7ee8ff';
            g.beginPath(); g.ellipse(w / 2, h / 2, 7, h / 2 * 0.8, 0, 0, Math.PI * 2); g.fill();
        });
        makeGlow('ebullet', 34, 34, (g, w, h) => {
            const grd = g.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, w / 2);
            grd.addColorStop(0, '#fff'); grd.addColorStop(0.35, '#ff5ecd');
            grd.addColorStop(1, 'rgba(255,60,160,0)');
            g.fillStyle = grd; g.fillRect(0, 0, w, h);
        });
        const pc = document.createElement('canvas'); pc.width = pc.height = 24;
        const pg = pc.getContext('2d');
        const pgrd = pg.createRadialGradient(12, 12, 0, 12, 12, 12);
        pgrd.addColorStop(0, 'rgba(255,255,255,1)');
        pgrd.addColorStop(0.35, 'rgba(255,200,110,0.75)');
        pgrd.addColorStop(1, 'rgba(255,120,40,0)');
        pg.fillStyle = pgrd; pg.fillRect(0, 0, 24, 24);
        GLOW.particle = pc;
    }
    buildGlowSprites();

    // ============================================================
    //  ИЗОБРАЖЕНИЯ + ФОЛЛБЕК
    // ============================================================
    const IMG = { enemies: [], boss: null };
    function loadImages() {
        ASSETS.imgs.forEach(src => {
            const im = new Image();
            im.onerror = () => { im.__broken = true; };
            im.src = src;
            IMG.enemies.push(im);
        });
        const b = new Image();
        b.onerror = () => { b.__broken = true; };
        b.src = ASSETS.boss;
        IMG.boss = b;
    }
    loadImages();

    function drawSpriteOrFallback(im, x, y, w, h, seed, isBoss) {
        if (im && im.complete && !im.__broken && im.naturalWidth) {
            ctx.drawImage(im, x, y, w, h);
            return;
        }
        drawProcedural(x, y, w, h, seed, isBoss);
    }

    // Фоллбек на случай 404 (регистр имени файла на GitHub-сервере и т.п.):
    // рисуем «Галюху» кодом — очки, пучок, указка, злое лицо.
    function drawProcedural(x, y, w, h, seed, isBoss) {
        const cx = x + w / 2, cy = y + h / 2, r = Math.min(w, h) / 2;
        const skin = isBoss ? '#f3c9a0' : '#e8b98f';
        ctx.save();
        // голова
        ctx.fillStyle = skin;
        ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.05, r * 0.78, r * 0.86, 0, 0, Math.PI * 2); ctx.fill();
        // волосы (пучок)
        ctx.fillStyle = isBoss ? '#3a2418' : '#4a2f20';
        ctx.beginPath(); ctx.arc(cx, cy - r * 0.75, r * 0.42, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(cx, cy - r * 0.28, r * 0.8, r * 0.55, 0, Math.PI, Math.PI * 2); ctx.fill();
        // очки
        ctx.strokeStyle = '#1b1b1b'; ctx.lineWidth = Math.max(1.4, r * 0.09);
        ctx.beginPath();
        ctx.arc(cx - r * 0.34, cy + r * 0.02, r * 0.26, 0, Math.PI * 2);
        ctx.moveTo(cx + r * 0.6, cy + r * 0.02);
        ctx.arc(cx + r * 0.34, cy + r * 0.02, r * 0.26, 0, Math.PI * 2);
        ctx.moveTo(cx - r * 0.08, cy + r * 0.02); ctx.lineTo(cx + r * 0.08, cy + r * 0.02);
        ctx.stroke();
        // злые брови
        ctx.beginPath();
        ctx.moveTo(cx - r * 0.6, cy - r * 0.28); ctx.lineTo(cx - r * 0.1, cy - r * 0.12);
        ctx.moveTo(cx + r * 0.6, cy - r * 0.28); ctx.lineTo(cx + r * 0.1, cy - r * 0.12);
        ctx.stroke();
        // рот
        ctx.beginPath(); ctx.arc(cx, cy + r * 0.62, r * 0.3, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
        // указка
        ctx.strokeStyle = '#c8a06a'; ctx.lineWidth = Math.max(1.5, r * 0.1);
        ctx.beginPath(); ctx.moveTo(cx + r * 0.75, cy + r * 0.1); ctx.lineTo(cx + r * 1.5, cy - r * 0.7); ctx.stroke();
        if (isBoss) {
            ctx.fillStyle = '#ff3b3b'; ctx.font = `bold ${Math.round(r * 0.5)}px Orbitron, sans-serif`;
            ctx.textAlign = 'center'; ctx.fillText('2', cx, cy + r * 0.1);
        }
        ctx.restore();
    }

    // ============================================================
    //  ЧАСТИЦЫ (пул + swap-pop, без splice)
    // ============================================================
    const partPool = [];
    function boom(x, y, count, color, power) {
        const cap = CFG.maxParticles;
        for (let i = 0; i < count && particles.length < cap; i++) {
            const a = Math.random() * Math.PI * 2;
            const v = (Math.random() * 210 + 90) * (power || 1);
            const p = partPool.pop() || {};
            p.x = x; p.y = y;
            p.vx = Math.cos(a) * v; p.vy = Math.sin(a) * v;
            p.r = Math.random() * 7 + 3;
            p.life = 1; p.decay = Math.random() * 1.4 + 1.1;   // в секунду
            p.color = color || `hsl(${Math.random() * 46 + 12},100%,58%)`;
            particles.push(p);
        }
    }
    function updateParticles(dt) {
        const s = dt / 1000;
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.x += p.vx * s; p.y += p.vy * s;
            p.vy += 620 * s; p.vx *= (1 - 0.9 * s);
            p.life -= p.decay * s;
            if (p.life <= 0) {
                partPool.push(p);
                const last = particles.pop();
                if (last !== p) particles[i] = last;
            }
        }
    }
    function drawParticles() {
        const img = GLOW.particle;
        for (const p of particles) {
            ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
            const s = p.r * (0.6 + p.life * 0.9);
            if (p.color) { ctx.fillStyle = p.color; ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s); }
            else ctx.drawImage(img, p.x - s, p.y - s, s * 2, s * 2);
        }
        ctx.globalAlpha = 1;
    }

    // ============================================================
    //  ЛЕТАЮЩИЙ ТЕКСТ
    // ============================================================
    function addText(x, y, text, color, size, decayPerSec) {
        floatTexts.push({ x, y, text, color, size: size || 22, life: 1, vy: -70, decay: decayPerSec || 1.1 });
    }
    function updateTexts(dt) {
        const s = dt / 1000;
        for (let i = floatTexts.length - 1; i >= 0; i--) {
            const t = floatTexts[i];
            t.y += t.vy * s; t.life -= t.decay * s;
            if (t.life <= 0) { const last = floatTexts.pop(); if (last !== t) floatTexts[i] = last; }
        }
    }
    function drawTexts() {
        ctx.textAlign = 'center';
        for (const t of floatTexts) {
            ctx.globalAlpha = Math.max(0, Math.min(1, t.life));
            ctx.fillStyle = t.color;
            ctx.font = `bold ${t.size}px Orbitron, sans-serif`;
            ctx.fillText(t.text, t.x, t.y);
        }
        ctx.globalAlpha = 1;
    }

    function doShake(amt, dur) { shake.amt = Math.max(shake.amt, amt); shake.dur = Math.max(shake.dur, dur); }
    function updateShake(dt) {
        if (shake.dur > 0) {
            shake.dur -= dt;
            const k = shake.amt * (shake.dur > 0 ? 1 : 0);
            shake.x = (Math.random() - 0.5) * k;
            shake.y = (Math.random() - 0.5) * k;
            if (shake.dur <= 0) { shake.x = shake.y = shake.amt = 0; }
        }
    }

    // ============================================================
    //  БАННЕР ВОЛНЫ (DOM — дешевле, чем перерисовка канваса)
    // ============================================================
    let bannerTimer = 0;
    function showBanner(text, cls, ms) {
        if (!banner) return;
        banner.textContent = text;
        banner.className = 'banner' + (cls ? ' ' + cls : '');
        bannerTimer = ms || 1600;
    }
    function updateBanner(dt) {
        if (!banner || bannerTimer <= 0) return;
        bannerTimer -= dt;
        if (bannerTimer <= 0) banner.classList.add('banner-hide');
    }

    // ============================================================
    //  ИГРОК
    // ============================================================
    function newUpgrades() {
        return {
            barrels: 1, fireRateMul: 1, damageMul: 1, homing: 0, pierce: 0,
            speedMul: 1, shield: 0, shieldMax: 0, regen: 0, crit: 0,
            sideGuns: 0, spread: 0, cheatCharges: CFG.cheatCharges, cheatCount: 0,
            taken: [],
        };
    }

    function initPlayer() {
        stat = { leaks: 0, bodyHits: 0, doubleHits: 0, livesLost: 0, gradeLost: 0, gradeRefunded: 0,
                 spawns: 0, killed: 0, bossKilled: 0, quizOk: 0, quizBad: 0, cheat: 0 };
        player = {
            x: W / 2, y: H - 100, w: 40, h: 50,
            invincible: false, invTimer: 0, grace: 0,
            shieldCharge: 0, shieldCd: 0,
            tilt: 0,
        };
    }

    function updatePlayer(dt) {
        const s = dt / 1000;
        const spd = CFG.playerSpeed * upgrades.speedMul;
        let dir = 0;
        if (keys['ArrowLeft'] || keys['KeyA']) dir -= 1;
        if (keys['ArrowRight'] || keys['KeyD']) dir += 1;
        if (dir) {
            player.x += dir * spd * s;
            player.tilt += (dir * 0.18 - player.tilt) * 0.2;
        } else {
            player.tilt += (0 - player.tilt) * 0.2;
        }
        if (pointerX !== null) {
            const target = Math.max(22, Math.min(W - 22, pointerX));
            player.aimX = target;                                // точка прицела (не зависит от скорости корабля)
            if (CFG.mouseFollow >= 1) {
                const maxStep = spd * s * CFG.mouseSpeedMul;
                const d = target - player.x;
                player.x += Math.max(-maxStep, Math.min(maxStep, d));
                player.tilt += (Math.max(-0.22, Math.min(0.22, d * 0.004)) - player.tilt) * 0.25;
            } else {
                player.x += (target - player.x) * (1 - Math.pow(1 - CFG.mouseFollow, dt / 16.67));
            }
        }
        player.x = Math.max(22, Math.min(W - 22, player.x));

        if (player.invincible) {
            player.invTimer -= dt;
            if (player.invTimer <= 0) { player.invincible = false; player.grace = 350; }
        }
        if (player.grace > 0) player.grace -= dt;
        if (player.shieldMax > 0) {
            if (player.shieldCharge < player.shieldMax) {
                player.shieldCd -= dt;
                if (player.shieldCd <= 0) { player.shieldCharge++; player.shieldCd = 12000; }
            } else player.shieldCd = 12000;
        }
        if (upgrades.regen > 0) {
            player.regenT = (player.regenT || 0) + dt;
            if (player.regenT > 20000) {
                player.regenT = 0;
                grades = Math.min(CFG.gradesMax, grades + 1);
                addText(player.x, player.y - 40, '+1 ОТДЫХ', '#0f0', 14, 1.3);
                syncHud();
            }
        }
    }

    function drawPlayer() {
        if (player.invincible && Math.floor(gameTime / 70) % 2) return;
        const { x, y } = player;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(player.tilt);

        // выхлоп: ПСЕВДО-шум по игровому времени. Важно: рендер не должен потреблять
        // Math.random — иначе лишние кадры в паузе/меню сдвигали бы будущие спавны.
        const flame = 10 + (0.5 + 0.5 * Math.sin(gameTime * 0.021) * Math.cos(gameTime * 0.013)) * 14;
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#ff8c1a';
        ctx.beginPath(); ctx.moveTo(-6, 22); ctx.lineTo(0, 22 + flame); ctx.lineTo(6, 22); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#ffe27a'; ctx.globalAlpha = 0.7;
        ctx.beginPath(); ctx.moveTo(-3, 22); ctx.lineTo(0, 22 + flame * 0.6); ctx.lineTo(3, 22); ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 1;

        // корпус
        ctx.fillStyle = '#0af';
        ctx.beginPath();
        ctx.moveTo(0, -25); ctx.lineTo(-20, 22); ctx.lineTo(-8, 16); ctx.lineTo(0, 22);
        ctx.lineTo(8, 16); ctx.lineTo(20, 22); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#0cf';
        ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(-6, 6); ctx.lineTo(6, 6); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#eafcff';
        ctx.fillRect(-1.5, -22, 3, 12);

        // доп. стволы, если есть
        if (upgrades.barrels > 1 || upgrades.sideGuns) {
            ctx.fillStyle = '#0ff';
            const n = upgrades.barrels;
            for (let i = 0; i < n; i++) {
                const off = (i - (n - 1) / 2) * 11;
                ctx.fillRect(off - 2, -18, 4, 10);
            }
            if (upgrades.sideGuns) { ctx.fillRect(-22, -8, 5, 12); ctx.fillRect(17, -8, 5, 12); }
        }
        ctx.restore();

        // щит
        if (player.shieldCharge > 0) {
            ctx.save();
            ctx.globalAlpha = 0.25 + 0.2 * Math.sin(gameTime / 220);
            ctx.strokeStyle = '#7dfff0'; ctx.lineWidth = 2 + player.shieldCharge;
            ctx.beginPath(); ctx.arc(x, y, 34 + player.shieldCharge * 3, 0, Math.PI * 2); ctx.stroke();
            ctx.restore();
        }
    }

    // ============================================================
    //  ПУЛИ
    // ============================================================
    function shoot() {
        const u = upgrades;
        const dmg = CFG.bulletDamage * u.damageMul;
        const spread = u.spread ? (Math.random() - 0.5) * u.spread : 0;
        // прицел: часть угла берём от курсора, так что кораблю НЕ обязательно встать ровно под врага
        const aimDx = (player.aimX == null ? player.x : player.aimX) - player.x;
        const aimAngle = Math.max(-0.5, Math.min(0.5, (aimDx / Math.max(200, player.y)) * CFG.aimAssist));
        const mk = (ox, angle, mul) => bullets.push({
            x: player.x + ox, y: player.y - 26,
            vx: Math.sin(angle + aimAngle) * CFG.bulletSpeed * mul,
            vy: -Math.cos(angle + aimAngle) * CFG.bulletSpeed * mul,
            dmg, pierce: u.pierce, hits: null, crit: u.crit && Math.random() < u.crit ? 2 : 1,
            homing: u.homing,
        });
        const n = u.barrels;
        for (let i = 0; i < n; i++) mk((i - (n - 1) / 2) * 11, spread, 1);   // параллельные стволы
        if (u.sideGuns) { mk(-20, 0.5 + spread, 0.95); mk(20, -0.5 + spread, 0.95); }
        if (audioReady && !muted) synthShoot();
    }

    function handleFiring(dt) {
        if (!firing) { fireTimer = 0; return; }
        fireTimer -= dt;
        if (fireTimer <= 0) {
            shoot();
            fireTimer = CFG.fireRate * upgrades.fireRateMul;
        }
    }

    function nearestEnemy(b) {
        let best = null, bd = 1e9;
        for (const e of enemies) {
            const d = (e.x - b.x) * (e.x - b.x) + (e.y - b.y) * (e.y - b.y);
            if (d < bd) { bd = d; best = e; }
        }
        if (boss) {
            const d = (boss.x - b.x) * (boss.x - b.x) + (boss.y - b.y) * (boss.y - b.y);
            if (d < bd) { bd = d; best = boss; }
        }
        return best;
    }

    function updateBullets(dt) {
        const s = dt / 1000;
        for (let i = bullets.length - 1; i >= 0; i--) {
            const b = bullets[i];
            if (b.homing) {
                const t = nearestEnemy(b);
                if (t) {
                    const ang = Math.atan2(t.y - b.y, t.x - b.x);
                    const cur = Math.atan2(b.vy, b.vx);
                    let d = ang - cur;
                    while (d > Math.PI) d -= Math.PI * 2;
                    while (d < -Math.PI) d += Math.PI * 2;
                    const turn = b.homing * s;
                    const na = cur + Math.max(-turn, Math.min(turn, d));
                    const sp = CFG.bulletSpeed;
                    b.vx = Math.cos(na) * sp; b.vy = Math.sin(na) * sp;
                }
            }
            b.x += b.vx * s; b.y += b.vy * s;
            if (b.y < -20 || b.x < -20 || b.x > W + 20) {
                const last = bullets.pop(); if (last !== b) bullets[i] = last;
            }
        }
    }

    function drawBullets() {
        const img = GLOW.bullet;
        for (const b of bullets) {
            ctx.save();
            ctx.translate(b.x, b.y);
            ctx.rotate(Math.atan2(b.vy, b.vx) + Math.PI / 2);
            ctx.drawImage(img, -10, -20, 20, 40);
            if (b.crit > 1) {
                ctx.globalAlpha = 0.5; ctx.fillStyle = '#fff';
                ctx.fillRect(-3, -22, 6, 44);
            }
            ctx.restore();
        }
        ctx.globalAlpha = 1;
    }

    // ---- пули врагов ----
    function spawnEnemyBullet(x, y, vx, vy, kind, dmg) {
        if (ebullets.length >= 18) return;       // «стена снарядов» невозможна по построению
        ebullets.push({ x, y, vx, vy, r: 9, kind: kind || 'double', life: 6000, dmg: dmg || 1 });
    }
    function updateEnemyBullets(dt) {
        const s = dt / 1000;
        for (let i = ebullets.length - 1; i >= 0; i--) {
            const b = ebullets[i];
            if (b.homing) {
                const ang = Math.atan2(player.y - b.y, player.x - b.x);
                const cur = Math.atan2(b.vy, b.vx);
                let d = ang - cur;
                while (d > Math.PI) d -= Math.PI * 2;
                while (d < -Math.PI) d += Math.PI * 2;
                const na = cur + Math.max(-1.1 * s, Math.min(1.1 * s, d));
                const sp = Math.hypot(b.vx, b.vy);
                b.vx = Math.cos(na) * sp; b.vy = Math.sin(na) * sp;
            }
            b.x += b.vx * s; b.y += b.vy * s; b.life -= dt;
            if (b.life <= 0 || b.y > H + 40 || b.y < -60 || b.x < -60 || b.x > W + 60) {
                const last = ebullets.pop(); if (last !== b) ebullets[i] = last;
                continue;
            }
            if (!player.invincible) {
                if (player.grace > 0) continue;               // 350мс неуязвимости к догоняющим пулям
                const dx = b.x - player.x, dy = b.y - player.y, rr = b.r + 15;
                if (dx * dx + dy * dy < rr * rr) {
                    const last = ebullets.pop(); if (last !== b) ebullets[i] = last;
                    stat.doubleHits++;
                    playerHit('double');
                }
            }
        }
    }
    function drawEnemyBullets() {
        const img = GLOW.ebullet;
        for (const b of ebullets) {
            if (b.kind === 'double') {
                ctx.save();
                ctx.translate(b.x, b.y);
                ctx.rotate(Math.atan2(b.vy, b.vx) + Math.PI / 2);
                ctx.globalAlpha = 0.55;
                ctx.drawImage(img, -17, -17, 34, 34);
                ctx.globalAlpha = 1;
                ctx.fillStyle = '#fff';
                ctx.font = 'bold 16px Orbitron, sans-serif'; ctx.textAlign = 'center';
                ctx.fillText('2', 0, 6);
                ctx.restore();
            } else {
                ctx.globalAlpha = 0.5; ctx.drawImage(img, b.x - 15, b.y - 15, 30, 30); ctx.globalAlpha = 1;
            }
        }
        ctx.globalAlpha = 1;
    }

    // ============================================================
    //  ВРАГИ (ГАЛЮХИ) — с паттернами вместо «просто падает»
    // ============================================================
    const PATTERNS = ['straight', 'zigzag', 'sine', 'drift', 'vee'];
    let enemySeq = 0;

    function spawnEnemy(forceKind) {
        if (enemies.length >= CFG.maxEnemies) return;
        stat.spawns++;
        const d = difficulty(wave);
        const sz = 44 + Math.random() * 20;
        const kind = forceKind || PATTERNS[Math.min(PATTERNS.length - 1, Math.floor(wave / 4))];
        const lane = wave >= 10
            ? (enemySeq % 2 ? 0.12 + Math.random() * 0.36 : 0.52 + Math.random() * 0.36)
            : Math.random();
        let sx = sz + lane * (W - sz * 2);
        // над игроком спавнить нельзя: минимум 130px по горизонтали (≈0.5с на уворот при 280px/s)
        if (player && Math.abs(sx - player.x) < 130 + sz / 2) {
            const side = player.x < W / 2 ? 1 : -1;
            sx = Math.max(sz, Math.min(W - sz, player.x + side * (150 + sz + Math.random() * (W / 2))));
            if (Math.abs(sx - player.x) < 130 + sz / 2) sx = Math.max(sz, Math.min(W - sz, player.x - side * (150 + sz)));
        }
        const isElite = Math.random() < d.elite;
        const hp = Math.max(1, Math.ceil(d.enemyHp * (isElite ? 2 : 1)));
        const shooter = !forceKind && wave >= 9 && Math.random() < Math.min(0.5, (wave - 8) * 0.045);
        enemies.push({
            x: sx,
            y: -sz,                             // спавним ВНЕ экрана, но РИСУЕМ-телеграф
            w: sz, h: sz,
            speed: d.enemySpeed * (0.85 + Math.random() * 0.3) / (1 + Math.max(0, (pressure - 1)) * 0.3),
            hp, maxHp: hp,
            img: IMG.enemies[Math.floor(Math.random() * IMG.enemies.length)],
            pattern: kind,
            amp: (Math.random() < 0.5 ? -1 : 1) * (40 + Math.random() * 70),
            freq: 1.1 + Math.random() * 1.2,
            phase: Math.random() * Math.PI * 2,
            baseX: 0, t: 0,
            flash: 0, seed: Math.random(),
            boss: false,
            shooter: shooter, shotT: 900 + Math.random() * 1400,
            elite: isElite,
        });
        const e = enemies[enemies.length - 1];
        e.baseX = Math.max(e.w / 2, Math.min(W - e.w / 2, e.x));
        e.x = e.baseX;
        enemySeq++;
    }

    function updateEnemies(dt) {
        const s = dt / 1000;
        for (let i = enemies.length - 1; i >= 0; i--) {
            const e = enemies[i];
            e.t += s;
            e.y += e.speed * s;
            switch (e.pattern) {
                case 'zigzag': e.x = e.baseX + Math.sin(e.t * e.freq * 2.4 + e.phase) * e.amp; break;
                case 'sine':   e.x = e.baseX + Math.sin(e.t * e.freq + e.phase) * e.amp * 1.6; break;
                case 'drift':  e.baseX += (e.amp > 0 ? 42 : -42) * s; e.x = e.baseX; break;
                case 'vee':    e.x = e.baseX + (e.baseX - W / 2) * Math.min(1.2, e.t * 0.5); break;
                default:       e.x = e.baseX;
            }
            const half = e.w / 2;
            if (e.baseX < half) { e.baseX = half; e.amp = Math.abs(e.amp); }
            if (e.baseX > W - half) { e.baseX = W - half; e.amp = -Math.abs(e.amp); }
            e.x = Math.max(half, Math.min(W - half, e.x));

            if (e.flash > 0) e.flash -= dt;

            if (e.shooter && e.y > 30 && e.y < H * 0.7) {
                e.shotT -= dt;
                if (e.shotT <= 0) {
                    e.shotT = 2600 + Math.random() * 1800;
                    const dx = player.x - e.x, dy = player.y - e.y;
                    const d = Math.max(1, Math.hypot(dx, dy));
                    const sp = 260 + Math.min(140, wave * 6);
                    spawnEnemyBullet(e.x, e.y + e.h / 2, dx / d * sp, dy / d * sp, 'double');
                    tone('square', 420, 220, 0.09, 0.03);
                }
            }

            // ---- ДОЛЕТЕЛА ДО ЗЕМЛИ ----
            // v1.0: playerHit() → −1 жизнь из 3. Теперь: −1 двойка в дневнике,
            // жизнь уходит только когда дневник пуст (или двойки кончились).
            if (e.y - e.h / 2 > H) {
                const last = enemies.pop(); if (last !== e) enemies[i] = last;
                leak();
                continue;
            }
            // столкновение с кораблём
            if (!player.invincible && e.y - e.h / 2 > 6) {
                const dx = e.x - player.x, dy = e.y - player.y, rr = e.w / 2 + 15;
                if (dx * dx + dy * dy < rr * rr) {
                    const last = enemies.pop(); if (last !== e) enemies[i] = last;
                    boom(e.x, e.y, 18, '#f44', 1.2);
                    stat.bodyHits++;
                    playerHit('body');
                }
            }
        }
    }

    function onScreen(e) { return e.y + e.h / 2 > 0; }

    function drawEnemies() {
        for (const e of enemies) {
            const visible = onScreen(e);
            if (!visible) {
                // ТЕЛЕГРАФ: враг ещё над экраном — рисуем метку у верхней кромки,
                // чтобы игрок заранее видел, откуда прилетит (в v1.0 враг был невидим).
                ctx.save();
                ctx.globalAlpha = 0.45;
                ctx.fillStyle = '#ff5a5a';
                ctx.beginPath();
                ctx.moveTo(e.x, 14); ctx.lineTo(e.x - 9, 2); ctx.lineTo(e.x + 9, 2);
                ctx.closePath(); ctx.fill();
                ctx.restore();
                continue;
            }
            ctx.save();
            if (e.flash > 0) { ctx.globalAlpha = 1; }
            drawSpriteOrFallback(e.img, e.x - e.w / 2, e.y - e.h / 2, e.w, e.h, e.seed, false);
            if (e.flash > 0) {                       // подложка вместо shadowBlur
                ctx.globalAlpha = Math.min(0.6, e.flash / 90);
                ctx.fillStyle = '#fff';
                ctx.beginPath(); ctx.arc(e.x, e.y, e.w * 0.55, 0, Math.PI * 2); ctx.fill();
            }
            ctx.globalAlpha = 1;
            if (e.elite) {                                   // метка «отличницы» вместо дорогого glow
                ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.arc(e.x, e.y, e.w * 0.62, 0, Math.PI * 2); ctx.stroke();
            }
            if (e.maxHp > 1) {
                const bw = e.w, bh = 4;
                const bx = e.x - bw / 2, by = e.y - e.h / 2 - 10;
                const ratio = Math.max(0, e.hp / e.maxHp);
                ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(bx, by, bw, bh);
                ctx.fillStyle = ratio > 0.5 ? '#5cff7a' : ratio > 0.25 ? '#ffd24a' : '#ff5a5a';
                ctx.fillRect(bx, by, bw * ratio, bh);
            }
            ctx.restore();
        }
    }

    // ============================================================
    //  БОСС: ГАЛЮХА-СТАРШЕГОДНИЦА
    // ============================================================
    function spawnBoss() {
        const d = difficulty(wave);
        const isFinal = wave >= 25 && Math.floor(wave / 5) % 6 === 5;
        const hp = Math.min(90, 18 + wave * 3) * (isFinal ? 2.2 : 1);
        boss = {
            x: W / 2, y: -120, w: 132, h: 132,
            hp: hp, maxHp: hp,
            dir: 1, speed: Math.min(340, 190 + wave * 7),
            state: 'enter',                      // enter → idle → telegraph → dive → return → quiz
            timer: 0, attack: 0, stun: 0, flash: 0, quizGap: 0,
            diveTarget: 0, quizDone: 0, quizStage: 0, quizGap: 0, quizPending: false, quizMarks: isFinal ? [0.8, 0.55, 0.3] : [0.72, 0.34],
            isFinal: isFinal,
            seed: Math.random(),
            name: isFinal ? 'ГАЛЮХА-ОТЛИЧНИЦА' : 'ГАЛЮХА-БОСС',
        };
        showBanner('⚠ ' + boss.name + ' ⚠', 'warn', 1900);
        playSfx('bossWarn', 0.55); synthBossWarn();
        doShake(6, 400);
    }

    function bossPattern(dt) {
        const d = difficulty(wave);
        const b = boss;
        const s = dt / 1000;
        if (b.flash > 0) b.flash -= dt;
        // викторина открывается сама, когда Галюху прижали: это НАГРАДА за агрессию
        if (b.quizGap > 0) b.quizGap -= dt / 1000;
        if (b.state === 'idle' && b.quizGap <= 0 && !b.quizPending &&
            b.quizStage < b.quizMarks.length && b.hp / b.maxHp <= b.quizMarks[b.quizStage]) {
            b.state = 'quiz'; b.quizPending = true; openQuiz();
        }
        if (b.stun > 0) { b.stun -= dt; return; }

        b.timer += dt;
        const homeY = Math.min(H * 0.18, 200) + b.h / 2;

        switch (b.state) {
            case 'enter':
                b.y += 260 * s;
                if (b.y >= homeY) { b.y = homeY; b.state = 'idle'; b.timer = 0; }
                break;

            case 'idle': {
                b.x += b.dir * b.speed * s;
                const pad = b.w / 2 + 16;
                if (b.x < pad) { b.x = pad; b.dir = 1; }
                if (b.x > W - pad) { b.x = W - pad; b.dir = -1; }
                b.bob = Math.sin(gameTime / 700) * 7; b.y = homeY + b.bob;

                const rest = Math.max(1500, 3200 - wave * 60);   // пауза между атаками
                if (b.timer > rest) {
                    b.timer = 0;
                    {
                        b.attack = (b.attack + 1) % (wave >= 12 ? 3 : 2);
                        b.state = b.attack === 1 ? 'fan' : (b.attack === 2 ? 'sweepwarn' : 'telegraph');
                        if (b.state === 'fan') fireFan();
                        if (b.state === 'sweepwarn') { b.sweep = { t: 0, dur: 900, fired: false }; showBanner('📓 ПРОВЕРКА ТЕТРАДЕЙ!', 'warn', 800); }
                        if (b.state === 'telegraph') { b.diveTarget = player.x; showBanner('📏 УКАЗКА!', 'warn', 700); }
                    }
                }
                break;
            }

            // 1) телеграф + пикирование (было в v1.0 без предупреждения)
            case 'telegraph':
                b.diveTarget += (player.x - b.diveTarget) * Math.min(1, s * 1.2); // догоняет лениво
                if (b.timer > 950) { b.state = 'dive'; b.timer = 0; }
                break;
            case 'dive': {
                const spd = d.diveSpeed;
                const ty = Math.min(H - 60, player.y - 6);
                b.y += spd * s;
                b.x += Math.sign(b.diveTarget - b.x) * Math.min(Math.abs(b.diveTarget - b.x), spd * 0.4 * s);
                if (b.y >= ty) { b.y = ty; b.state = 'return'; doShake(9, 260); playSfx('playerHit', 0.2); }
                break;
            }
            case 'return':
                b.y -= 420 * s;
                if (b.y <= homeY) { b.y = homeY; b.state = 'idle'; b.timer = 0; }
                break;

            // 2) веер двоек
            case 'fan':
                if (b.timer > 420) { b.state = 'idle'; b.timer = 0; }
                break;

            // 3) «проверка тетрадей»: мигает зона (900мс) → по ней идут двойки, которые надо перепрыгнуть
            case 'sweepwarn':
                if (b.sweep) {
                    b.sweep.t += dt;
                    if (b.sweep.t >= b.sweep.dur) { fireSweep(); b.state = 'sweep'; b.timer = 0; }
                } else { b.state = 'idle'; b.timer = 0; }
                break;
            case 'sweep':
                if (b.sweep) {
                    b.sweep.t += dt;
                    if (b.sweep.t > 1500) { b.sweep = null; }
                }
                if (b.timer > 1500) { b.state = 'idle'; b.timer = 0; }
                break;

            // 4) викторина
            case 'quiz':
                if (b.timer > CFG.quizTime) closeQuiz(false, true);
                for (const q of bubbles) if (q.pop) { bubbles = []; break; }
                break;
        }
        b.x = Math.max(b.w / 2, Math.min(W - b.w / 2, b.x));
    }

    function fireFan() {
        const d = difficulty(wave);
        const n = 3 + Math.floor(wave / 8) + (d.extra || 0);
        for (let i = 0; i < n; i++) {
            const a = (i - (n - 1) / 2) * 0.28 + Math.PI / 2;
            const sp = 210 + Math.min(120, wave * 5);
            spawnEnemyBullet(boss.x, boss.y + 40, Math.cos(a) * sp, Math.sin(a) * sp, 'double');
        }
        for (let i = 0; i < n; i++) { const eb = ebullets[ebullets.length - 1 - i]; if (eb) eb.homing = wave >= 16 ? 0.55 : 0; }
        tone('square', 300, 160, 0.16, 0.05);
    }

    function fireSweep() {
        // редкая «строка двоек» с зазором, который всегда можно пройти (не сплошная стена)
        const n = Math.min(5, 3 + Math.floor((wave - 12) / 8));
        const gap = W / (n + 1);
        const safe = Math.floor(Math.random() * (n + 1));      // один заведомо свободный коридор
        for (let i = 0; i <= n; i++) {
            if (i === safe) continue;
            spawnEnemyBullet(i * gap, -30, 0, 320 + Math.min(160, wave * 5), 'double');
        }
        boss.sweep = { t: 0, dur: 1500 };
        tone('sawtooth', 180, 90, 0.5, 0.05);
    }

    // ---------- ВИКТОРИНА «ЗАДАЧА НА ДОСКЕ» ----------
    // Честность: правильный вариант ПОДСВЕЧЕН первые 1.6с (надо запомнить), потом подсветка гаснет.
    const QUIZ_HINT = 1600;
    function openQuiz() {
        if (boss) { boss.quizGap = (CFG.quizCooldown || 5000) / 1000; }
        bubbles = [];
        const a = 2 + Math.floor(Math.random() * 9);
        const b = 2 + Math.floor(Math.random() * 9);
        const ans = a * b;
        const opts = [ans];
        while (opts.length < 3) {
            const fake = Math.max(2, ans + (Math.random() < 0.5 ? -1 : 1) * (1 + Math.floor(Math.random() * 8)));
            if (!opts.includes(fake)) opts.push(fake);
        }
        opts.sort(() => Math.random() - 0.5);
        const y = Math.min(H * 0.42, 320);
        opts.forEach((v, i) => {
            bubbles.push({
                x: W * (0.28 + i * 0.22), y: y + (i % 2 ? 26 : 0),
                w: 76, h: 52, value: v, correct: v === ans,
                life: CFG.quizTime / 1000, pop: 0, hint: QUIZ_HINT,
            });
        });
        boss.quizAnswer = `${a} × ${b} = ?`;
        showBanner('🧮 РЕШИ: ' + boss.quizAnswer, 'quiz', 3400);
        tone('triangle', 520, 780, 0.3, 0.06);
    }

    function closeQuiz(ok, timeout) {
        if (boss) { boss.state = 'idle'; boss.timer = 0; boss.stun = Math.max(boss.stun, ok ? 1600 : 300); }
        if (!ok) {
            addText(W / 2, H * 0.45, timeout ? 'НЕ УСПЕЛ' : 'НЕВЕРНО!', '#ff8a3b', 22, 1.1);
        doShake(4, 140);
            synthQuiz(false);
            if (!timeout) { spawnEnemy(); score = Math.max(0, score - 60); }   // за ошибку — штраф, не казнь
        }
        bubbles = [];
    }

    function updateBubbles(dt) {
        for (const q of bubbles) { q.life -= dt / 1000; if (q.hint > 0) q.hint -= dt; }
    }
    function drawBubbles() {
        for (const q of bubbles) {
            ctx.save();
            const k = Math.max(0, Math.min(1, q.life * 2));
            ctx.globalAlpha = 0.15 + 0.85 * k;
            const hint = q.hint > 0 && q.correct;
            ctx.fillStyle = q.pop === 1 ? '#2bff8f' : q.pop === 2 ? '#ff5a5a' : (hint ? '#1d3a2c' : '#0d1030');
            ctx.strokeStyle = q.pop ? (q.pop === 1 ? '#2bff8f' : '#ff5a5a') : (hint ? '#2bff8f' : '#8fe9ff');
            ctx.lineWidth = hint ? 3 : 2;
            roundRect(q.x - q.w / 2, q.y - q.h / 2, q.w, q.h, 10);
            ctx.fill(); ctx.stroke();
            ctx.fillStyle = '#eafcff';
            ctx.font = 'bold 24px Orbitron, sans-serif'; ctx.textAlign = 'center';
            ctx.fillText(q.value, q.x, q.y + 9);
            ctx.restore();
        }
    }
    function roundRect(x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function updateBoss(dt) {
        if (!boss) return;
        bossPattern(dt);
        // контактный урон
        if (!player.invincible && boss.y > 0 && boss.state !== 'quiz') {
            const dx = boss.x - player.x, dy = boss.y - player.y, rr = boss.w / 2 + 16;
            if (dx * dx + dy * dy < rr * rr) playerHit('boss');
        }
    }

    function drawBoss() {
        if (!boss) return;
        const b = boss;
        ctx.save();
        if (b.stun > 0) { ctx.translate(Math.sin(gameTime / 40) * 3, 0); }
        drawSpriteOrFallback(IMG.boss, b.x - b.w / 2, b.y - b.h / 2, b.w, b.h, b.seed, true);
        if (b.flash > 0) {
            ctx.globalAlpha = Math.min(0.55, b.flash / 90);
            ctx.fillStyle = '#fff';
            ctx.beginPath(); ctx.arc(b.x, b.y, b.w * 0.55, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = 1;
        }
        // телеграф пикирования
        if (b.state === 'telegraph') {
            const k = Math.min(1, b.timer / 950);
            ctx.globalAlpha = 0.15 + 0.35 * Math.abs(Math.sin(gameTime / 120));
            ctx.fillStyle = '#ff3b3b';
            ctx.fillRect(b.diveTarget - 26, b.y + b.h / 2, 52, H - b.y);
            ctx.globalAlpha = 0.8;
            ctx.fillStyle = '#fff'; ctx.font = 'bold 14px Orbitron, sans-serif'; ctx.textAlign = 'center';
            ctx.fillText(Math.round(k * 100) + '%', b.diveTarget, b.y + b.h / 2 + 34);
            ctx.globalAlpha = 1;
        }
        if (b.sweep) {
            const k = Math.min(1, b.sweep.t / b.sweep.dur);
            if (b.state === 'sweepwarn') {
                ctx.globalAlpha = 0.18 + 0.22 * Math.abs(Math.sin(gameTime / 90));
                ctx.fillStyle = '#ff2bd0';
                ctx.fillRect(0, 0, W, H * 0.18);
                ctx.globalAlpha = 1;
                ctx.fillStyle = '#ffd6f4'; ctx.font = 'bold 12px Orbitron, sans-serif'; ctx.textAlign = 'center';
                ctx.fillText('ПРЫГАЙ ИЛИ ПОЛУЧИ ДВОЙКИ', W / 2, H * 0.18 - 8);
            } else {
                ctx.globalAlpha = 0.12;
                ctx.fillStyle = '#ff2bd0';
                ctx.fillRect(0, -20 + k * (H + 40), W, 40);
                ctx.globalAlpha = 1;
            }
        }
        ctx.restore();

        // полоса HP
        const bw = Math.min(W * 0.6, 520), bx = (W - bw) / 2, by = 22;
        const r = Math.max(0, b.hp / b.maxHp);
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(bx - 3, by - 3, bw + 6, 18);
        ctx.fillStyle = r > 0.5 ? '#ff4fd8' : r > 0.25 ? '#ffb03b' : '#ff3b3b';
        ctx.fillRect(bx, by, bw * r, 12);
        ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.lineWidth = 1;
        ctx.strokeRect(bx, by, bw, 12);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 11px Orbitron, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(b.name + (b.stun > 0 ? '  [ОТВЛЕЧЕНА ЗАДАЧЕЙ]' : ''), W / 2, by + 26);
    }

    // ============================================================
    //  СТОЛКНОВЕНИЯ (squared-distance, без Math.hypot)
    // ============================================================
    function checkCollisions() {
        for (let bi = bullets.length - 1; bi >= 0; bi--) {
            const b = bullets[bi];
            let consumed = false;

            // 1) answer-баблсы босса
            if (boss && boss.state === 'quiz' && bubbles.length) {
                for (let qi = bubbles.length - 1; qi >= 0; qi--) {
                    const q = bubbles[qi];
                    if (Math.abs(b.x - q.x) < q.w / 2 && Math.abs(b.y - q.y) < q.h / 2) {
                        q.pop = q.correct ? 1 : 2;
                        if (q.correct) {
                            stat.quizOk++;
                            boss.hp -= boss.maxHp * 0.18;
                            boss.stun = 1600;
                            addText(q.x, q.y - 30, 'ПРАВИЛЬНО! −18% HP', '#2bff8f', 20, 1.0);
                            boom(q.x, q.y, 16, '#2bff8f', 1.1);
                            synthQuiz(true); playSfx('kill', 0.4);
                            score += 150;
                            if (boss.hp <= 0) killBoss();
                            else { bubbles = []; boss.state = 'idle'; boss.timer = 0; }
                        } else {
                            stat.quizBad++;
                            addText(q.x, q.y - 30, 'ОШИБКА!', '#ff5a5a', 20, 1.0);
                            synthQuiz(false);
                            grades = Math.max(0, grades - 1);
                            syncHud();
                            if (grades === 0) loseLife('no-grades');
                        }
                        consumed = true;
                        break;
                    }
                }
                if (consumed) { const last = bullets.pop(); if (last !== b) bullets[bi] = last; continue; }
            }

            // 2) враги
            for (let ei = enemies.length - 1; ei >= 0; ei--) {
                const e = enemies[ei];
                if (!onScreen(e)) continue;
                const dx = b.x - e.x, dy = b.y - e.y, rr = e.w / 2 + 7;
                if (dx * dx + dy * dy < rr * rr) {
                    if (b.pierce > 0 && !b.hits) b.hits = new Set();
                    if (b.pierce > 0 && b.hits && b.hits.has(e)) continue;
                    e.hp -= b.dmg * b.crit;
                    e.flash = 90;
                    boom(b.x, b.y, 3, '#9ff', 0.7);
                    synthHit();
                    if (b.pierce > 0) { b.hits.add(e); b.pierce--; if (b.pierce < 0) consumed = true; }
                    else consumed = true;

                    if (e.hp <= 0) {
                        killEnemy(ei);
                    }
                    if (consumed) break;
                }
            }
            if (consumed) { const last = bullets.pop(); if (last !== b) bullets[bi] = last; }
        }

        // 3) босс
        if (boss && boss.state !== 'quiz') {
            for (let bi = bullets.length - 1; bi >= 0; bi--) {
                const b = bullets[bi];
                const dx = b.x - boss.x, dy = b.y - boss.y, rr = boss.w / 2 + 8;
                if (dx * dx + dy * dy < rr * rr) {
                    boss.hp -= b.dmg * b.crit;
                    boss.flash = 80;
                    boom(b.x, b.y, 3, '#ffb0ff', 0.7);
                    synthHit();
                    const last = bullets.pop(); if (last !== b) bullets[bi] = last;
                    if (boss.hp <= 0) { killBoss(); break; }
                }
            }
        }
    }

    function killEnemy(i) {
        const e = enemies[i];
        const pts = 100 + wave * 12;
        score += pts;
        addText(e.x, e.y, '+' + pts, '#7ee8ff', 18, 1.3);
        boom(e.x, e.y, 14, '#ff9a3b', 1);
        playSfx('kill', 0.45); synthKill();
        totalKills++; killsSinceRefund++;
        if (killsSinceRefund >= CFG.gradeRefundKills) {
            killsSinceRefund = 0;
            if (grades < CFG.gradesMax) { grades++; addText(e.x, e.y - 24, '+1 ДВОЙКА ИСПРАВЛЕНА', '#2bff8f', 13, 1.1); }
        }
        stat.killed++;
        const last = enemies.pop(); if (last !== e) enemies[i] = last;
        syncHud();
    }

    function killBoss() {
        const b = boss;
        const pts = 600 + wave * 180 + (b.isFinal ? 2000 : 0);
        score += pts;
        boom(b.x, b.y, 46, '#ffd24a', 1.6);
        addText(W / 2, H / 2 - 20, 'ГАЛЮХА УНИЧТОЖЕНА! +' + pts, '#2bff8f', 26, 0.55);
        showBanner(b.isFinal ? 'ЗАЧЁТ. ТЫ ЭТО СДЕЛАЛ.' : '💀 ОЦЕНКА ИСПРАВЛЕНА', 'good', 2200);
        playSfx('bossKill', 0.6); synthBossKill();
        doShake(18, 620);
        slowmo = 420;
        grades = Math.min(CFG.gradesMax, grades + 2);
        stat.bossKilled++;
        boss = null;
        // босс-волна не «пустая», как в v1.0: добиваем остаток роя — он сейчас спавнется вместе с боссом
        syncHud();
    }

    // ============================================================
    //  УРОН / ДНЕВНИК / GAME OVER
    // ============================================================
    function leak() {
        waveGradesLost++;
        hurt(0.34);
        stat.leaks++;
        if (grades > 0) {
            stat.gradeLost++;
            grades--;
            addText(W / 2, H - 60, 'ДВОЙКА В ДНЕВНИКЕ!', '#ff8a3b', 20, 1.0);
            boom(player.x, H - 12, 8, '#ff5a5a', 0.6);
            doShake(3, 120);
            tone('square', 300, 180, 0.12, 0.05);
            syncHud();
            if (grades === 0) {
                stat.gradeLost--;                 // этот «минус» уже перешёл в жизнь
                showBanner('📕 ДНЕВНИК ПУСТ — ГАЛЮХА В ЯРОСТИ', 'warn', 1400);
                loseLife('no-grades');
            }
        } else {
            stat.gradeLost--;
            loseLife('leak');
        }
    }

    function playerHit(kind) {
        if (player.invincible) return;
        if (player.shieldCharge > 0) {
            player.shieldCharge--;
            hurt(0.18);
            player.shieldCd = 12000;
            player.invincible = true; player.invTimer = 900;
            boom(player.x, player.y, 16, '#7dfff0', 1.1);
            addText(player.x, player.y - 44, 'ЩИТ ПОГЛОТИЛ', '#7dfff0', 16, 1.2);
            tone('sine', 900, 300, 0.2, 0.08);
            return;
        }
        loseLife(kind);
    }

    function loseLife(kind) {
        if (dead) return;
        waveLivesLost++;
        stat.livesLost++;
        hurt(0.6);
        lives--;
        player.invincible = true; player.invTimer = CFG.invincTime;
        grades = Math.max(grades, Math.ceil(CFG.gradesMax / 2));   // передышка: дневник частично «пересдан»
        doShake(10, 280);
        flash = 0.6;
        playSfx('playerHit', 0.55); synthHurt();
        syncHud();
        if (lives <= 0) gameOver(kind);
    }

    function gameOver(kind) {
        dead = true;
        running = false;
        cancelAnimationFrame(animId);
        stopMusic();
        playSfx('gameover', 0.6);
        elFinalScore.textContent = score;
        elFinalWave.textContent = wave;
        if (elFinalUpg) {
            const names = upgrades.taken.map(id => (UPGRADES[id] || { short: id }).short);
            elFinalUpg.textContent = names.length ? names.join(' · ') : 'ни одного (жаль)';
        }
        const reasons = {
            'boss': 'Тебя Галюха ёбнула! 💀',
            'body': 'В тебя влетела Галюха! 💀',
            'double': 'Тебя завалили двойками! 💀',
            'leak': 'Галюхи долетели до журнала! 💀',
            'no-grades': 'Дневник кончился, а Галюхи — нет! 💀',
        };
        const sub = document.getElementById('gameover-subtitle');
        if (sub) sub.textContent = reasons[kind] || 'Тебя Галюха ёбнула! 💀';
        setTimeout(() => showScreen(overScreen), 550);
    }

    function syncHud() {
        elScore.textContent = score;
        elLives.textContent = Math.max(0, lives);
        elWave.textContent = wave;
        if (elGrades) {
            elGrades.textContent = grades + '/' + CFG.gradesMax;
            elGrades.parentElement.classList.toggle('low', grades <= 2);
        }
        if (elCheat) {
            elCheat.textContent = upgrades ? upgrades.cheatCharges : 0;
            elCheat.parentElement.classList.toggle('ready', !!upgrades && upgrades.cheatCharges > 0);
        }
    }

    // ============================================================
    //  «ЗАЧЁТКА» — аварийная кнопка
    // ============================================================
    function useCheat() {
        if (!running || paused || !upgrades || upgrades.cheatCharges <= 0) return;
        upgrades.cheatCharges--;
        stat.cheat++;
        addText(player.x, player.y - 60, 'ЗАЧЁТКА!', '#ffd24a', 26, 1.0);
        showBanner('📝 ЗАЧЁТКА: нижняя треть вычищена', 'good', 1200);
        synthCheat();
        player.invincible = true; player.invTimer = Math.max(player.invTimer, 900);
        grades = Math.min(CFG.gradesMax, grades + 2);
        for (let i = enemies.length - 1; i >= 0; i--) {
            const e = enemies[i];
            if (e.y > H * 0.62) {
                boom(e.x, e.y, 10, '#ffd24a', 0.9);
                score += 40;
                const last = enemies.pop(); if (last !== e) enemies[i] = last;
            }
        }
        ebullets = ebullets.filter(b => b.y < H * 0.62);
        doShake(12, 320);
        syncHud();
    }

    // ============================================================
    //  ВОЛНЫ + ПРОКАЧКА
    // ============================================================
    // ---- ДИНАМИЧЕСКИЙ ГЕЙМ-МАСТЕР ----
    // Идея: не давить числами, а держать игрока на его собственном потолке.
    //  • волна без потерь двоек и без урона  → давление +12% (до ×1.35)
    //  • утекли двойки                       → давление −10%
    //  • потеряна жизнь                        → давление −25% (анти-спираль, чтобы не добить)
    // Так «сложно» всегда = «вровень с тобой», а не «гарантированно невозможно».
    let pressure = 1;
    let pain = 0;                                   // EMA «боли» 0..1, реагирует мгновенно
    let spawnLeft = 0;                              // сколько ещё заплановано (можно урезать на лету)
    let waveGradesLost = 0, waveLivesLost = 0;
    function hurt(k) { pain = Math.min(1, pain + k); }
    function coolPain(dt) { pain += (0 - pain) * Math.min(1, dt / 2600); }
    const painMul = () => 1 + 0.95 * pain;           // боль 1.0 → спавн вдвое медленнее
    function gameMasterCount(base) {
        return Math.max(3, Math.round(base * pressure));
    }
    function gameMasterInterval(base) {
        // давление умеет только ЗАМЕДЛЯТЬ спавн (когда больно), но не ускорять его
        // в обход safeSpawnInterval — иначе инвариант ломается.
        return Math.max(520, base * Math.min(1, 2 - pressure) * (0.85 + 0.6 * painMul() * 0.4));
    }

    function startWave() {
        waveState = 'active';
        const d = difficulty(wave);
        const isBoss = wave % CFG.bossEvery === 0;
        toSpawn = isBoss ? Math.round(gameMasterCount(d.count) * d.swarm) : gameMasterCount(d.count);
        spawnLeft = toSpawn;
        spawnInterval = gameMasterInterval(safeSpawnInterval(d.enemyHp, Math.max(560, d.interval)));
        spawnTimer = spawnInterval * 0.5;
        if (isBoss) { spawnBoss(); }
        else {
            showBanner('ВОЛНА ' + wave, 'wave', 1300);
            synthWave();
        }
        elWave.textContent = wave;
    }

    function updateWave(dt) {
        if (waveState === 'active') {
            // МЯГКИЙ КАП ЭКРАНА. Ключ к починке v1.0: очередь не может расти быстрее,
            // чем игрок её разбирает. onCap = «сколько врагов игрок успевает переварить».
            const onCap = Math.max(4, Math.round(2.5 + playerDps() / 1.35 - pain * 2));
            if (toSpawn > 0) {
                spawnTimer += dt;
                if (spawnTimer >= spawnInterval) {
                    spawnInterval = gameMasterInterval(safeSpawnInterval(difficulty(wave).enemyHp, Math.max(560, difficulty(wave).interval)));
                    if (enemies.length + (boss ? 1 : 0) < onCap && spawnLeft > 0) {
                        spawnTimer = 0;
                        // «галочкой»: 1-3 врага за раз, темп спавна за счёт этого не растёт
                        const group = wave >= 12 ? Math.min(toSpawn, spawnLeft, 1 + (Math.random() * 3 | 0)) : 1;
                        for (let g = 0; g < group; g++) spawnEnemy();
                        toSpawn -= group;
                        spawnLeft -= group;
                    } else if (pain > 0.5 && enemies.length > onCap * 0.7) {
                        // больно → укорачиваем хвост волны, а не добиваем игрока очередью
                        spawnLeft = Math.max(0, spawnLeft - 1);
                        toSpawn = Math.min(toSpawn, spawnLeft);
                    }
                }
            }
            const cleared = toSpawn <= 0 && enemies.length === 0 && !boss;
            if (toSpawn > 0 && pain > 0.75 && enemies.length === 0) { toSpawn = 0; spawnLeft = 0; }
            if (cleared) {
                waveState = 'cooldown';
                wavePauseTimer = 0;
                if (waveGradesLost === 0 && waveLivesLost === 0) pressure = Math.min(1.35, pressure * 1.12);
                else if (waveGradesLost >= 3)                     pressure = Math.max(0.72, pressure * 0.88);
                else if (waveLivesLost > 0)                      pressure = Math.max(0.8,  pressure * 0.75);
                else                                             pressure = Math.max(0.8,  pressure * 0.90);
                waveGradesLost = 0; waveLivesLost = 0;
                showBanner('✔ ВОЛНА ' + wave + ' ПРОЙДЕНА', 'good', 1400);
                playSfx('bossKill', 0.15); synthDone();
                score += 200 + wave * 40;
                grades = Math.min(CFG.gradesMax, grades + 1);
                if (upgrades.cheatCount < 3 && wave % 3 === 0) { upgrades.cheatCharges++; }
                syncHud();
                openPicker();
            }
            return;
        }
        wavePauseTimer += dt;
        if (wavePauseTimer >= CFG.wavePause) {
            wave++;
            paused = false;
            showScreen(gameScreen);
            lastTime = performance.now();
            startWave();
        }
    }

    // ---------------- апгрейды ----------------
    const UPGRADES = {
        dual:      { name: 'ДВОЙНАЯ ТЯГА',        short: '2 ствола',      desc: '+1 ствол параллельно. Спавн перестанет обгонять твой DPS.', max: 3,
                     apply: u => u.barrels++ },
        fireRate:  { name: 'МЕЛОМ БЫСТРЕЕ',       short: 'скорострельность', desc: '−20% к задержке выстрела.', max: 4,
                     apply: u => u.fireRateMul = Math.max(0.35, u.fireRateMul * 0.8) },
        dmg:       { name: 'ТАБЛИЦА УМНОЖЕНИЯ',   short: '×2 урон',        desc: 'Урон пули ×1.7. Галюхи толстеют, а ты — нет.', max: 3,
                     apply: u => u.damageMul *= 1.7 },
        homing:    { name: 'ТЕОРЕМА ПИФАГОРА',    short: 'самонаведение',  desc: 'Пули доворачивают к ближайшей Галюхе.', max: 3,
                     apply: u => u.homing += 3.2 },
        pierce:    { name: 'СКВОЗЬ ТЕТРАДЬ',      short: 'пробитие +1',    desc: 'Пуля пробивает ещё одного врага.', max: 2,
                     apply: u => u.pierce++ },
        spread:    { name: 'ВЕЕР КОНТРОЛЬНЫХ',    short: 'разброс',        desc: 'Пули летят с лёгким разбросом — проще попадать по зигзагам.', max: 2,
                     apply: u => u.spread += 0.06 },
        speed:     { name: 'ФИЗРА ВМЕСТО АЛГЕБРЫ', short: '+22% скорости',  desc: 'Быстрее уворачиваться от пикирующей Галюхи.', max: 4,
                     apply: u => u.speedMul *= 1.22 },
        life:      { name: 'ОТДЫХ',               short: '+1 жизнь',       desc: 'Жизнь +1, и сразу 2 двойки исправлены.', max: 3,
                     apply: u => { lives++; grades = Math.min(CFG.gradesMax, grades + 2); } },
        shield:    { name: 'ШПАРГАЛКА',            short: 'щит',            desc: '+1 заряд щита, впитывает удар и восстанавливается сам.', max: 2,
                     apply: u => { u.shieldMax++; player.shieldCharge++; } },
        regen:     { name: 'САМОПОДГОТОВКА',       short: 'реген двоек',    desc: 'Раз в 20 сек +1 двойка в дневнике автоматически.', max: 2,
                     apply: u => u.regen++ },
        crit:      { name: 'ОТЛИЧНИК',             short: 'крит 25%',       desc: '25% шанс двойного урона. Иногда везёт.', max: 3,
                     apply: u => u.crit = Math.min(0.75, u.crit + 0.25) },
        cheat:     { name: 'ЗАЧЁТКА',              short: '+1 зачётка',     desc: 'Ещё одна кнопка E: чистит нижнюю треть и даёт двойки.', max: 3,
                     apply: u => { u.cheatCharges++; u.cheatCount++; } },
    };

    function rollChoices(n) {
        const pool = Object.keys(UPGRADES).filter(id => (upgrades.takenCount(id) || 0) < UPGRADES[id].max);
        if (!pool.length) return [];
        // приоритет: если DPS сильно отстаёт от спавна — в пул чаще падают стволы/урон
        const need = dpsDeficit();
        const out = [];
        while (out.length < n && pool.length) {
            const weighted = [];
            for (const id of pool) {
                if (out.includes(id)) continue;
                let w = 1;
                if (need > 0.15 && (id === 'dual' || id === 'dmg' || id === 'fireRate' || id === 'pierce')) w = 3;
                if (need < -0.3 && (id === 'life' || id === 'shield' || id === 'speed')) w = 2;
                for (let k = 0; k < w; k++) weighted.push(id);
            }
            if (!weighted.length) break;
            out.push(weighted[Math.floor(Math.random() * weighted.length)]);
        }
        return out;
    }

    function playerDps() {
        const u = upgrades;
        const shots = 1000 / (CFG.fireRate * u.fireRateMul);
        const bullets = u.barrels + u.sideGuns * 2;
        return shots * bullets * u.damageMul;
    }
    function dpsDeficit() {
        const d = difficulty(wave);
        const need = (1 / (d.interval / 1000)) * d.enemyHp;      // «хитов/сек», которые надо выдерживать
        return need / Math.max(1, playerDps()) - 0.6;            // цель: 40% запаса
    }

    function openPicker() {
        const ids = rollChoices(3);
        if (!ids.length) {                                  // всё прокачано — бонус вместо мёртвого экрана
            score += 800 + wave * 30;
            lives = Math.min(9, lives + (lives < 6 ? 1 : 0));
            addText(W / 2, H * 0.4, 'ВСЁ ПРОКАЧАНО  +' + (800 + wave * 30), '#ffd24a', 22, 0.7);
            showBanner('🏆 ВСЁ ПРОКАЧАНО — ГАЛЮХА В ШОКЕ', 'good', 1500);
            syncHud();
            wavePauseTimer = CFG.wavePause;
            return;
        }
        paused = true;
        pickerCards.innerHTML = '';
        ids.forEach(id => {
            const u = UPGRADES[id];
            const btn = document.createElement('button');
            btn.className = 'upg-card';
            btn.innerHTML = `<span class="upg-name">${u.name}</span>
                             <span class="upg-tag">${u.short}</span>
                             <span class="upg-desc">${u.desc}</span>`;
            btn.addEventListener('click', () => {
                u.apply(upgrades);
                upgrades.taken.push(id);
                upgrades._counts = upgrades._counts || {};
                upgrades._counts[id] = (upgrades._counts[id] || 0) + 1;
                synthUpgrade();
                closePicker();
            });
            pickerCards.appendChild(btn);
        });
        const skip = document.createElement('button');
        skip.className = 'upg-card upg-skip';
        skip.innerHTML = '<span class="upg-name">ПРОПУСТИТЬ</span><span class="upg-desc">Двойка за лень, но +500 очков</span>';
        skip.addEventListener('click', () => { score += 500; synthUpgrade(); closePicker(); });
        pickerCards.appendChild(skip);
        showScreen(pickerScreen);
    }
    function closePicker() {
        showScreen(gameScreen);
        paused = false;
        wavePauseTimer = 0;
        lastTime = performance.now();
        syncHud();
    }

    // ============================================================
    //  ГЛАВНЫЙ ЦИКЛ
    // ============================================================
    function loop(time) {
        if (!running) return;
        animId = requestAnimationFrame(loop);

        let dt = Math.min(time - lastTime, 50);
        lastTime = time;
        if (dt <= 0) dt = 16.67;
        if (slowmo > 0) { slowmo -= dt; dt *= 0.35; }

        if (!paused) {
            updateStars(dt);
            updatePlayer(dt);
            handleFiring(dt);
            updateBullets(dt);
            updateEnemies(dt);
            updateBoss(dt);
            updateEnemyBullets(dt);
            updateBubbles(dt);
            updateParticles(dt);
            updateTexts(dt);
            checkCollisions();
            coolPain(dt);
            updateWave(dt);
            updateShake(dt);
            updateBanner(dt);
        }

        // Пауза = стоп-кадр: канвас сохраняет последний кадр, перерисовка не нужна.
        // Побочный, но важный эффект: отрисовка не потребляет ничего «случайного»,
        // поэтому число кадров, проведённых в меню апгрейда, не влияет на будущие спавны.
        if (paused) return;
        ctx.save();
        ctx.translate(shake.x, shake.y);
        ctx.fillStyle = '#050510';
        ctx.fillRect(-20, -20, W + 40, H + 40);
        drawStars();
        drawBullets();
        drawEnemyBullets();
        drawEnemies();
        drawBoss();
        drawBubbles();
        drawPlayer();
        drawParticles();
        drawTexts();
        ctx.restore();

        if (flash > 0) {
            ctx.globalAlpha = flash;
            ctx.fillStyle = 'rgba(255,40,40,0.5)';
            ctx.fillRect(0, 0, W, H);
            ctx.globalAlpha = 1;
            flash -= dt / 700;
        }
    }

    // ============================================================
    //  СТАРТ / МЕНЮ
    // ============================================================
    function startGame() {
        initAudio();
        resize();
        initStars();

        score = 0; lives = CFG.lives; wave = 1; grades = CFG.gradesMax;
        dead = false; paused = false; slowmo = 0; flash = 0;
        bullets = []; enemies = []; ebullets = []; particles = []; floatTexts = []; bubbles = [];
        boss = null;
        totalKills = 0; killsSinceRefund = 0;
        upgrades = newUpgrades();
        upgrades.takenCount = function (id) { return (this._counts || {})[id] || 0; };
        fireTimer = 0; firing = false; pointerX = null; pointerActive = false;
        shake.x = shake.y = shake.amt = shake.dur = 0;

        initPlayer();
        showScreen(gameScreen);
        syncHud();
        setTimeout(() => { if (running) startMusic(); }, 250);

        running = true;
        lastTime = performance.now();
        gameTime = 0;
        animId = requestAnimationFrame(loop);
        startWave();
    }

    function toMenu() {
        running = false;
        cancelAnimationFrame(animId);
        stopMusic();
        showScreen(menuScreen);
    }

    function togglePause() {
        if (!running) return;
        paused = !paused;
        if (!paused) lastTime = performance.now();
        showBanner(paused ? '⏸ ПАУЗА (P — продолжить)' : '', paused ? 'good' : '', paused ? 99999 : 900);
    }

    // ============================================================
    //  УПРАВЛЕНИЕ
    // ============================================================
    window.addEventListener('keydown', e => {
        keys[e.code] = true;
        if (e.code === 'Space') { e.preventDefault(); firing = true; }
        if (e.code === 'KeyE') { useCheat(); }
        if (e.code === 'KeyP' || e.code === 'Escape') { if (running && !pickerVisible()) togglePause(); }
    });
    window.addEventListener('keyup', e => {
        keys[e.code] = false;
        if (e.code === 'Space') firing = false;
    });
    function pickerVisible() { return pickerScreen && !pickerScreen.classList.contains('hidden'); }

    const localX = e => {
        const r = canvas.getBoundingClientRect();
        return (e.clientX != null ? e.clientX : 0) - r.left;
    };
    canvas.addEventListener('mousemove', e => {
        if (!running) return;
        pointerX = localX(e);
    });
    canvas.addEventListener('mousedown', e => {
        if (!running || pickerVisible()) return;
        pointerX = localX(e);
        firing = true;
        pointerActive = true;
    });
    window.addEventListener('mouseup', () => { firing = false; pointerActive = false; });
    canvas.addEventListener('mouseleave', () => { if (!pointerActive) pointerX = null; });

    canvas.addEventListener('touchstart', e => {
        e.preventDefault();
        if (!running || pickerVisible()) return;
        pointerX = localX(e.touches[0]);
        firing = true; pointerActive = true;
    }, { passive: false });
    canvas.addEventListener('touchmove', e => {
        e.preventDefault();
        if (e.touches.length) pointerX = localX(e.touches[0]);
    }, { passive: false });
    canvas.addEventListener('touchend', e => {
        e.preventDefault();
        if (e.touches.length) pointerX = localX(e.touches[0]);
        else { firing = false; pointerActive = false; }
    }, { passive: false });
    document.addEventListener('gesturestart', e => e.preventDefault());

    if (btnSound) { btnSound.textContent = muted ? '🔇' : '🔊'; btnSound.addEventListener('click', toggleMute); }
    btnPlay.addEventListener('click', startGame);
    btnRestart.addEventListener('click', startGame);
    btnMenu.addEventListener('click', toMenu);


    // ============================================================
    //  ОТЛАДОЧНЫЙ ХУК (только для автотестов; перед релизом можно удалить)
    // ============================================================
    window.__DBG = {
        state: () => ({ score, lives, wave, grades, running, paused, dead,
                        enemies: enemies.length, bullets: bullets.length,
                        ebullets: ebullets.length, particles: particles.length,
                        boss: boss ? boss.hp : null, upgrades: upgrades && upgrades.taken,
                        maxGrades: CFG.gradesMax, maxEnemies: CFG.maxEnemies, toSpawn,
                        playerX: player && player.x, playerY: player && player.y,
                        enemiesList: enemies.map(e => ({ x: e.x, y: e.y, w: e.w, hp: e.hp })),
                        bossList: boss ? [{ x: boss.x, y: boss.y, w: boss.w }] : [],
                        waveState, fireTimer, pressure, pain, wavePauseTimer, gameTime, stat: { ...stat },
                        difficulty: difficulty(wave) }),
        set: (o) => {
            if ('wave' in o) wave = o.wave;
            if ('lives' in o) lives = o.lives;
            if ('firing' in o) firing = o.firing;
            if ('pointerX' in o) pointerX = o.pointerX;
            if ('grades' in o) grades = o.grades;
        },
        forceWave: (n) => { wave = n; startWave(); },
        restart: (w) => { startGame(); if (w) { wave = w; startWave(); } },
        useCheat: () => useCheat(),
        playerDps: () => playerDps(),
        killAllEnemies: () => { enemies.length = 0; toSpawn = 0; },
        rollChoices: (n) => rollChoices(n || 3),
        pickUpgrade: (id) => {                 // тесты: дать конкретный апгрейд, минуя клик по карточке
            const u = UPGRADES[id]; if (!u || !upgrades) return false;
            u.apply(upgrades); upgrades.taken.push(id);
            upgrades._counts = upgrades._counts || {};
            upgrades._counts[id] = (upgrades._counts[id] || 0) + 1;
            return true;
        },
        setGrades: (n) => { grades = n; syncHud(); },   // тесты: и значение, и перерисовка HUD
        hit:       () => playerHit('test'),     // тесты: спровоцировать урон по игроку
        clearIfr:  () => { if (player) { player.invincible = false; player.invTimer = 0; player.grace = 0; } },
        difficulty: () => difficulty(wave),
        waveState: () => waveState,
    };

    resize();
    initStars();
})();
