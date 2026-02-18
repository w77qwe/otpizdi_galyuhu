/* ==============================================
   СИМУЛЯТОР: ОТПИЗДИ ГАЛЮХУ
   Autistic Games | ВайкокинStar Games
   ============================================== */

(function () {
    'use strict';

    // ======= DOM =======
    const menuScreen   = document.getElementById('menu-screen');
    const gameScreen   = document.getElementById('game-screen');
    const overScreen   = document.getElementById('gameover-screen');
    const canvas       = document.getElementById('gameCanvas');
    const ctx          = canvas.getContext('2d');
    const elScore      = document.getElementById('score');
    const elLives      = document.getElementById('lives');
    const elWave       = document.getElementById('wave');
    const elFinalScore = document.getElementById('final-score');
    const elFinalWave  = document.getElementById('final-wave');
    const btnPlay      = document.getElementById('btn-play');
    const btnFire      = document.getElementById('btn-fire');
    const btnRestart   = document.getElementById('btn-restart');
    const btnMenu      = document.getElementById('btn-menu');

    // ======= КАРТИНКИ =======
    const ENEMY_IMGS = ['shit1.png','shit2.png','shit3.png','shit4.png'].map(src => {
        const img = new Image(); img.src = src; return img;
    });
    const BOSS_IMG = new Image();
    BOSS_IMG.src = 'shit_final.png';

    // ======= КОНФИГ =======
    const CFG = {
        playerSpeed : 7,
        bulletSpeed : 11,
        fireRate    : 170,
        enemySpeed  : 1.5,
        enemyCount  : 4,
        bossEvery   : 5,
        bossHp      : 15,
        lives       : 3,
        invincTime  : 2000,
        wavePause   : 2500,
        spawnDelay  : 1200,
    };

    // ======= СОСТОЯНИЕ =======
    let W, H;
    let score, lives, wave;
    let running = false;
    let animId, lastTime;

    let player    = {};
    let bullets   = [];
    let enemies   = [];
    let particles = [];
    let floatTexts= [];
    let stars     = [];

    let toSpawn, spawnTimer, spawnInterval;
    let waveState, wavePauseTimer;
    let bossAlive;

    let keys    = {};
    let pointerX = null;
    let firing  = false;
    let fireTimer = 0;

    let invincible, invTimer;
    let shakeX, shakeY, shakeAmt, shakeDur;

    // ======= РЕСАЙЗ =======
    function resize() {
        W = canvas.width  = window.innerWidth;
        H = canvas.height = window.innerHeight;
        if (player && player.y) player.y = H - 100;
    }
    window.addEventListener('resize', resize);
    resize();

    // ======= ЭКРАНЫ =======
    function showScreen(el) {
        [menuScreen, gameScreen, overScreen].forEach(s => s.classList.add('hidden'));
        el.classList.remove('hidden');
    }

    // ============================================================
    //  ЗВЁЗДЫ (фон)
    // ============================================================
    function initStars() {
        stars = [];
        for (let i = 0; i < 130; i++) {
            stars.push({
                x: Math.random() * W,
                y: Math.random() * H,
                r: Math.random() * 1.8 + 0.3,
                speed: Math.random() * 2 + 0.5,
                alpha: Math.random() * 0.7 + 0.3
            });
        }
    }

    function updateStars() {
        for (const s of stars) {
            s.y += s.speed;
            if (s.y > H) { s.y = -2; s.x = Math.random() * W; }
        }
    }

    function drawStars() {
        for (const s of stars) {
            ctx.globalAlpha = s.alpha;
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    // ============================================================
    //  ИГРОК
    // ============================================================
    function initPlayer() {
        player = { x: W / 2, y: H - 100, w: 40, h: 50 };
    }

    function updatePlayer(dt) {
        if (keys['ArrowLeft']  || keys['KeyA']) player.x -= CFG.playerSpeed;
        if (keys['ArrowRight'] || keys['KeyD']) player.x += CFG.playerSpeed;

        if (pointerX !== null) {
            player.x += (pointerX - player.x) * 0.14;
        }

        player.x = Math.max(22, Math.min(W - 22, player.x));

        if (invincible) {
            invTimer -= dt;
            if (invTimer <= 0) invincible = false;
        }
    }

    function drawPlayer() {
        if (invincible && Math.floor(Date.now() / 80) % 2) return;

        const { x, y } = player;
        ctx.save();
        ctx.translate(x, y);

        // Двигатель (пламя)
        ctx.shadowBlur = 12;
        ctx.shadowColor = '#f80';
        ctx.fillStyle = '#f80';
        const flame = 8 + Math.random() * 12;
        ctx.beginPath();
        ctx.moveTo(-6, 22);
        ctx.lineTo(0, 22 + flame);
        ctx.lineTo(6, 22);
        ctx.closePath();
        ctx.fill();

        // Корпус
        ctx.shadowColor = '#0ff';
        ctx.shadowBlur = 15;
        ctx.fillStyle = '#0af';
        ctx.beginPath();
        ctx.moveTo(0, -25);
        ctx.lineTo(-20, 22);
        ctx.lineTo(-8, 16);
        ctx.lineTo(0, 22);
        ctx.lineTo(8, 16);
        ctx.lineTo(20, 22);
        ctx.closePath();
        ctx.fill();

        // Кабина
        ctx.fillStyle = '#0ff';
        ctx.beginPath();
        ctx.moveTo(0, -16);
        ctx.lineTo(-6, 6);
        ctx.lineTo(6, 6);
        ctx.closePath();
        ctx.fill();

        ctx.restore();
    }

    // ============================================================
    //  ПУЛИ
    // ============================================================
    function shoot() {
        bullets.push({ x: player.x, y: player.y - 28, w: 4, h: 14 });
    }

    function handleFiring(dt) {
        if (!firing) { fireTimer = 0; return; }
        fireTimer -= dt;
        if (fireTimer <= 0) {
            shoot();
            fireTimer = CFG.fireRate;
        }
    }

    function updateBullets() {
        for (let i = bullets.length - 1; i >= 0; i--) {
            bullets[i].y -= CFG.bulletSpeed;
            if (bullets[i].y < -20) bullets.splice(i, 1);
        }
    }

    function drawBullets() {
        ctx.save();
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#0ff';
        ctx.fillStyle = '#0ff';
        for (const b of bullets) {
            ctx.globalAlpha = 1;
            ctx.fillRect(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h);
            ctx.globalAlpha = 0.3;
            ctx.fillRect(b.x - b.w, b.y, b.w * 2, b.h * 1.5);
        }
        ctx.globalAlpha = 1;
        ctx.restore();
    }

    // ============================================================
    //  ВРАГИ (ГАЛЮХИ)
    // ============================================================
    function spawnEnemy(isBoss) {
        const sz  = isBoss ? 110 : 48 + Math.random() * 24;
        const spd = isBoss
            ? 0.7 + wave * 0.08
            : CFG.enemySpeed + wave * 0.15 + Math.random() * 1.2;
        const hp  = isBoss ? CFG.bossHp + wave * 2 : 1;

        enemies.push({
            x: Math.random() * (W - sz * 2) + sz,
            y: -sz,
            w: sz,
            h: sz,
            speed: spd,
            hp: hp,
            maxHp: hp,
            img: isBoss ? BOSS_IMG : ENEMY_IMGS[Math.floor(Math.random() * ENEMY_IMGS.length)],
            boss: !!isBoss,
            zigzag: !isBoss && Math.random() > 0.4,
            zigAmp: (Math.random() - 0.5) * 4,
            angle: Math.random() * Math.PI * 2,
            flash: 0
        });
    }

    function updateEnemies(dt) {
        for (let i = enemies.length - 1; i >= 0; i--) {
            const e = enemies[i];
            e.y += e.speed;

            if (e.zigzag) {
                e.angle += 0.04;
                e.x += Math.sin(e.angle) * e.zigAmp;
            }

            if (e.boss) {
                e.x += Math.sin(Date.now() / 600) * 2.5;
                if (e.y > H * 0.22) e.y = H * 0.22;
            }

            e.x = Math.max(e.w / 2, Math.min(W - e.w / 2, e.x));
            if (e.flash > 0) e.flash -= dt;

            // Улетел за экран — урон игроку
            if (!e.boss && e.y > H + e.h) {
                enemies.splice(i, 1);
                playerHit();
            }
        }
    }

    function drawEnemies() {
        for (const e of enemies) {
            ctx.save();

            if (e.flash > 0) {
                ctx.shadowBlur = 25;
                ctx.shadowColor = '#fff';
            }

            ctx.drawImage(e.img, e.x - e.w / 2, e.y - e.h / 2, e.w, e.h);

            // HP-бар босса
            if (e.boss && e.hp > 0) {
                const bw = e.w * 1.3;
                const bh = 8;
                const bx = e.x - bw / 2;
                const by = e.y - e.h / 2 - 20;
                const ratio = e.hp / e.maxHp;

                ctx.fillStyle = '#222';
                ctx.fillRect(bx, by, bw, bh);

                ctx.fillStyle = ratio > 0.5 ? '#0f0' : ratio > 0.25 ? '#ff0' : '#f00';
                ctx.fillRect(bx, by, bw * ratio, bh);

                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1;
                ctx.strokeRect(bx, by, bw, bh);

                ctx.fillStyle = '#ff0';
                ctx.font = 'bold 14px Orbitron';
                ctx.textAlign = 'center';
                ctx.shadowBlur = 8;
                ctx.shadowColor = '#ff0';
                ctx.fillText('ГАЛЮХА-БОСС', e.x, by - 6);
            }

            ctx.restore();
        }
    }

    // ============================================================
    //  ЧАСТИЦЫ (взрывы)
    // ============================================================
    function boom(x, y, count, color) {
        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const v = Math.random() * 5 + 2;
            particles.push({
                x, y,
                vx: Math.cos(a) * v,
                vy: Math.sin(a) * v,
                r: Math.random() * 4 + 1.5,
                life: 1,
                decay: Math.random() * 0.025 + 0.015,
                color: color || `hsl(${Math.random() * 50 + 10},100%,55%)`
            });
        }
    }

    function updateParticles() {
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.06;
            p.life -= p.decay;
            if (p.life <= 0) particles.splice(i, 1);
        }
    }

    function drawParticles() {
        for (const p of particles) {
            ctx.save();
            ctx.globalAlpha = p.life;
            ctx.shadowBlur = 6;
            ctx.shadowColor = p.color;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }

    // ============================================================
    //  ЛЕТАЮЩИЙ ТЕКСТ (+100, "ВОЛНА 5" и т.д.)
    // ============================================================
    function addText(x, y, text, color, size, decay) {
        floatTexts.push({
            x, y, text, color,
            size: size || 22,
            life: 1,
            vy: -1.2,
            decay: decay || 0.015
        });
    }

    function updateTexts() {
        for (let i = floatTexts.length - 1; i >= 0; i--) {
            const t = floatTexts[i];
            t.y += t.vy;
            t.life -= t.decay;
            if (t.life <= 0) floatTexts.splice(i, 1);
        }
    }

    function drawTexts() {
        for (const t of floatTexts) {
            ctx.save();
            ctx.globalAlpha = t.life;
            ctx.fillStyle = t.color;
            ctx.font = `bold ${t.size}px Orbitron`;
            ctx.textAlign = 'center';
            ctx.shadowBlur = 12;
            ctx.shadowColor = t.color;
            ctx.fillText(t.text, t.x, t.y);
            ctx.restore();
        }
    }

    // ============================================================
    //  СТОЛКНОВЕНИЯ
    // ============================================================
    function dist(ax, ay, bx, by) {
        return Math.hypot(ax - bx, ay - by);
    }

    function checkCollisions() {
        // Пули → Враги
        for (let bi = bullets.length - 1; bi >= 0; bi--) {
            const b = bullets[bi];
            for (let ei = enemies.length - 1; ei >= 0; ei--) {
                const e = enemies[ei];
                if (dist(b.x, b.y, e.x, e.y) < e.w / 2 + 6) {
                    bullets.splice(bi, 1);
                    e.hp--;
                    e.flash = 80;
                    boom(b.x, b.y, 4, '#0ff');

                    if (e.hp <= 0) {
                        const pts = e.boss ? 500 * wave : 100;
                        score += pts;
                        elScore.textContent = score;

                        boom(e.x, e.y, e.boss ? 50 : 18, e.boss ? '#ff0' : '#f80');
                        addText(e.x, e.y, '+' + pts, e.boss ? '#ff0' : '#0ff');

                        if (e.boss) {
                            bossAlive = false;
                            doShake(14, 500);
                            addText(W / 2, H / 2, 'ГАЛЮХА УНИЧТОЖЕНА!', '#0f0', 26, 0.008);
                        }
                        enemies.splice(ei, 1);
                    }
                    break;
                }
            }
        }

        // Игрок → Враги
        if (!invincible) {
            for (let ei = enemies.length - 1; ei >= 0; ei--) {
                const e = enemies[ei];
                if (dist(player.x, player.y, e.x, e.y) < e.w / 2 + 16) {
                    if (!e.boss) enemies.splice(ei, 1);
                    boom(player.x, player.y, 22, '#f44');
                    playerHit();
                    break;
                }
            }
        }
    }

    // ============================================================
    //  УРОН / GAME OVER
    // ============================================================
    function playerHit() {
        if (invincible) return;
        lives--;
        elLives.textContent = lives;
        invincible = true;
        invTimer = CFG.invincTime;
        doShake(8, 250);
        if (lives <= 0) gameOver();
    }

    function gameOver() {
        running = false;
        cancelAnimationFrame(animId);
        elFinalScore.textContent = score;
        elFinalWave.textContent  = wave;
        setTimeout(() => showScreen(overScreen), 600);
    }

    // ============================================================
    //  ТРЯСКА ЭКРАНА
    // ============================================================
    function doShake(amt, dur) {
        shakeAmt = amt;
        shakeDur = dur;
    }

    function updateShake(dt) {
        if (shakeDur > 0) {
            shakeDur -= dt;
            shakeX = (Math.random() - 0.5) * shakeAmt;
            shakeY = (Math.random() - 0.5) * shakeAmt;
            if (shakeDur <= 0) shakeX = shakeY = shakeAmt = 0;
        }
    }

    // ============================================================
    //  ВОЛНЫ
    // ============================================================
    function startWave() {
        waveState = 'active';
        const isBoss = wave % CFG.bossEvery === 0;

        if (isBoss) {
            toSpawn = 0;
            spawnEnemy(true);
            bossAlive = true;
            addText(W / 2, H / 2 - 30, '⚠ БОСС-ГАЛЮХА ⚠', '#ff0', 28, 0.008);
        } else {
            toSpawn = CFG.enemyCount + wave * 2;
            spawnInterval = Math.max(350, CFG.spawnDelay - wave * 40);
            spawnTimer = 0;
            addText(W / 2, H / 2, 'ВОЛНА ' + wave, '#0ff', 32, 0.008);
        }

        elWave.textContent = wave;
    }

    function updateWave(dt) {
        if (waveState === 'active') {
            if (toSpawn > 0) {
                spawnTimer += dt;
                if (spawnTimer >= spawnInterval) {
                    spawnTimer = 0;
                    spawnEnemy(false);
                    toSpawn--;
                }
            }

            if (toSpawn <= 0 && enemies.length === 0) {
                waveState = 'cooldown';
                wavePauseTimer = 0;
                addText(W / 2, H / 2, '✔ ВОЛНА ПРОЙДЕНА!', '#0f0', 26, 0.008);
            }
        } else {
            wavePauseTimer += dt;
            if (wavePauseTimer >= CFG.wavePause) {
                wave++;
                startWave();
            }
        }
    }

    // ============================================================
    //  ГЛАВНЫЙ ЦИКЛ
    // ============================================================
    function loop(time) {
        if (!running) return;
        animId = requestAnimationFrame(loop);

        const dt = Math.min(time - lastTime, 50);
        lastTime = time;

        // --- Обновление ---
        updateStars();
        updatePlayer(dt);
        handleFiring(dt);
        updateBullets();
        updateEnemies(dt);
        updateParticles();
        updateTexts();
        checkCollisions();
        updateWave(dt);
        updateShake(dt);

        // --- Отрисовка ---
        ctx.save();
        ctx.translate(shakeX, shakeY);

        ctx.fillStyle = '#050510';
        ctx.fillRect(-10, -10, W + 20, H + 20);

        drawStars();
        drawBullets();
        drawEnemies();
        drawPlayer();
        drawParticles();
        drawTexts();

        ctx.restore();
    }

    // ============================================================
    //  СТАРТ / РЕСТАРТ / МЕНЮ
    // ============================================================
    function startGame() {
        resize();

        score = 0;
        lives = CFG.lives;
        wave  = 1;
        elScore.textContent = '0';
        elLives.textContent = lives;
        elWave.textContent  = '1';

        bullets = []; enemies = []; particles = []; floatTexts = [];
        invincible = false; invTimer = 0;
        bossAlive  = false;
        shakeX = shakeY = shakeAmt = shakeDur = 0;
        fireTimer = 0;
        firing = false;
        pointerX = null;

        initStars();
        initPlayer();
        showScreen(gameScreen);

        running  = true;
        lastTime = performance.now();
        animId   = requestAnimationFrame(loop);

        startWave();
    }

    function toMenu() {
        running = false;
        cancelAnimationFrame(animId);
        showScreen(menuScreen);
    }

    // ============================================================
    //  УПРАВЛЕНИЕ
    // ============================================================

    // --- Клавиатура ---
    window.addEventListener('keydown', e => {
        keys[e.code] = true;
        if (e.code === 'Space') { e.preventDefault(); firing = true; }
    });
    window.addEventListener('keyup', e => {
        keys[e.code] = false;
        if (e.code === 'Space') firing = false;
    });

    // --- Мышь (десктоп) ---
    canvas.addEventListener('mousemove', e => { if (running) pointerX = e.clientX; });
    canvas.addEventListener('mousedown', () => { if (running) firing = true; });
    canvas.addEventListener('mouseup',   () => { firing = false; });
    canvas.addEventListener('mouseleave',() => { pointerX = null; });

    // --- Тач (мобилка) ---
    canvas.addEventListener('touchstart', e => {
        e.preventDefault();
        if (running && e.touches.length) pointerX = e.touches[0].clientX;
    }, { passive: false });

    canvas.addEventListener('touchmove', e => {
        e.preventDefault();
        if (running && e.touches.length) pointerX = e.touches[0].clientX;
    }, { passive: false });

    canvas.addEventListener('touchend', e => {
        e.preventDefault();
        if (e.touches.length > 0) {
            pointerX = e.touches[0].clientX;
        } else {
            pointerX = null;
        }
    }, { passive: false });

    // --- Кнопка огня ---
    btnFire.addEventListener('mousedown', e => { e.stopPropagation(); firing = true; });
    btnFire.addEventListener('mouseup',   () => { firing = false; });
    btnFire.addEventListener('touchstart', e => {
        e.preventDefault(); e.stopPropagation(); firing = true;
    }, { passive: false });
    btnFire.addEventListener('touchend', e => {
        e.preventDefault(); e.stopPropagation(); firing = false;
    }, { passive: false });

    // --- Кнопки UI ---
    btnPlay.addEventListener('click', startGame);
    btnRestart.addEventListener('click', startGame);
    btnMenu.addEventListener('click', toMenu);

})();