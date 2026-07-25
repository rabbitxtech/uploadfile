// RabbitWorld Saga — Người Giữ Lõi (Step A: playable core).
// A single-player, keyboard-driven top-down action-RPG rendered on canvas. This
// runs entirely client-side (no room / WebSocket) so movement and combat stay
// smooth. Echo explores one region (Rừng Tệp Tin), fights corrupted data enemies
// with a basic attack + dash + 4 skills, levels up, and must defeat the boss to
// claim the Core Shard. Progress (best level / cleared) is saved to localStorage.
//
// Architecture: all mutable world state lives in a ref (gameRef) updated inside a
// requestAnimationFrame loop — React state is only a throttled HUD snapshot, so
// the render loop never churns the React tree.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const VIEW_W = 820;
const VIEW_H = 540;
const WORLD_W = 1760;
const WORLD_H = 1180;
const SAVE_KEY = 'rpg-rabbitworld';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// ---- Skills ---------------------------------------------------------------
// Each skill: hotkey label, MP cost, cooldown (ms), and a cast(g) that mutates
// the world. Basic attack + dash are handled separately (no MP).
const SKILLS = [
  {
    id: 'swirl', key: 'U', mp: 12, cd: 2600, color: '#f97316',
    cast(g) {
      spawnRing(g, g.player.x, g.player.y, 92, '#f97316');
      aoeDamage(g, g.player.x, g.player.y, 92, 26);
    },
  },
  {
    id: 'bolt', key: 'I', mp: 6, cd: 480, color: '#38bdf8',
    cast(g) {
      const f = g.player.face;
      g.projectiles.push({ x: g.player.x, y: g.player.y, vx: f.x * 8.5, vy: f.y * 8.5, team: 'player', dmg: 20, r: 7, life: 1400, color: '#38bdf8' });
    },
  },
  {
    id: 'storm', key: 'O', mp: 22, cd: 6000, color: '#a78bfa',
    cast(g) {
      g.effects.push({ type: 'storm', x: g.player.x, y: g.player.y, r: 120, life: 2200, tick: 0, dmg: 12, color: '#a78bfa' });
    },
  },
  {
    id: 'heal', key: 'P', mp: 18, cd: 7000, color: '#34d399',
    cast(g) {
      g.player.hp = clamp(g.player.hp + 45, 0, g.player.maxHp);
      spawnRing(g, g.player.x, g.player.y, 60, '#34d399');
      for (let i = 0; i < 12; i += 1) spawnParticle(g, g.player.x, g.player.y, '#6ee7b7');
    },
  },
];

// Ambient dust motes / fireflies drifting over the scene (pure eye-candy).
function makeMotes() {
  const m = [];
  for (let i = 0; i < 60; i += 1) {
    m.push({ x: Math.random() * WORLD_W, y: Math.random() * WORLD_H, ph: Math.random() * Math.PI * 2, sp: 0.2 + Math.random() * 0.4 });
  }
  return m;
}

// ---- World setup ----------------------------------------------------------
function createGame(startLevel = 1) {
  const obstacles = [
    [240, 220, 120, 60, 'rock'], [560, 420, 80, 160, 'tree'], [820, 180, 140, 70, 'rock'],
    [420, 760, 180, 70, 'bush'], [980, 620, 90, 200, 'tree'], [1240, 300, 110, 110, 'rock'],
    [1300, 820, 160, 80, 'bush'], [700, 940, 120, 70, 'rock'], [160, 560, 80, 200, 'tree'],
  ];
  const player = {
    x: 120, y: WORLD_H / 2, r: 15, speed: 2.1, face: { x: 1, y: 0 },
    hp: 100, maxHp: 100, mp: 60, maxMp: 60, level: startLevel, xp: 0, xpNext: 12,
    atkCd: 0, dashCd: 0, dashTime: 0, hurtCd: 0, skillCd: [0, 0, 0, 0], walkPhase: 0,
    jumpTime: 0, jumpDur: 520,
  };
  const g = {
    player, obstacles, enemies: [], projectiles: [], effects: [], particles: [], floaters: [],
    cam: { x: 0, y: 0 }, keys: {}, status: 'playing', message: 'Rừng Tệp Tin', messageT: 2600,
    bossActive: false, time: 0, shake: 0, motes: makeMotes(),
  };
  // Scatter roaming enemies across the region.
  const spots = [
    [520, 300, 'glitch'], [700, 360, 'glitch'], [620, 620, 'frag'],
    [900, 320, 'glitch'], [1040, 480, 'frag'], [880, 780, 'glitch'],
    [1180, 640, 'glitch'], [1120, 900, 'frag'], [1320, 520, 'glitch'],
    [460, 900, 'glitch'], [780, 200, 'frag'],
  ];
  for (const [x, y, type] of spots) g.enemies.push(makeEnemy(type, x, y));
  // Boss guards the Core Shard at the far right (dormant until approached).
  g.boss = makeBoss(WORLD_W - 160, WORLD_H / 2);
  g.enemies.push(g.boss);
  return g;
}

function makeEnemy(type, x, y) {
  if (type === 'frag') return { type, x, y, r: 14, hp: 34, maxHp: 34, speed: 0.52, atkCd: 0, xp: 4, contact: 8 };
  return { type: 'glitch', x, y, r: 15, hp: 42, maxHp: 42, speed: 0.7, atkCd: 0, xp: 5, contact: 12 };
}

function makeBoss(x, y) {
  return { type: 'boss', x, y, r: 34, hp: 520, maxHp: 520, speed: 0.56, atkCd: 0, slamCd: 0, xp: 60, contact: 18, dormant: true, phase: 1 };
}

// ---- Spawn / effect helpers ----------------------------------------------
function spawnRing(g, x, y, r, color) { g.effects.push({ type: 'ring', x, y, r, life: 360, color }); }
function spawnParticle(g, x, y, color) {
  const a = Math.random() * Math.PI * 2;
  const s = 1 + Math.random() * 2.5;
  g.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 350 + Math.random() * 250, color });
}
function spawnFloater(g, x, y, text, color) { g.floaters.push({ x, y, text, color, life: 700 }); }

function aoeDamage(g, x, y, r, dmg) {
  for (const e of g.enemies) {
    if (e.hp <= 0 || e.dormant) continue;
    if (dist(x, y, e.x, e.y) <= r + e.r) hurtEnemy(g, e, dmg);
  }
}
function hurtEnemy(g, e, dmg) {
  e.hp -= dmg;
  spawnFloater(g, e.x, e.y - e.r, String(dmg), '#fde047');
  for (let i = 0; i < 5; i += 1) spawnParticle(g, e.x, e.y, e.type === 'boss' ? '#f472b6' : '#a3e635');
}

// ---- Collision against walls / obstacles ----------------------------------
function collideWorld(ent) {
  ent.x = clamp(ent.x, ent.r, WORLD_W - ent.r);
  ent.y = clamp(ent.y, ent.r, WORLD_H - ent.r);
}
function blockedByObstacle(g, x, y, r) {
  for (const [ox, oy, ow, oh] of g.obstacles) {
    const cx = clamp(x, ox, ox + ow);
    const cy = clamp(y, oy, oy + oh);
    if (dist(x, y, cx, cy) < r) return true;
  }
  return false;
}
function moveEntity(g, ent, dx, dy) {
  if (!blockedByObstacle(g, ent.x + dx, ent.y, ent.r)) ent.x += dx;
  if (!blockedByObstacle(g, ent.x, ent.y + dy, ent.r)) ent.y += dy;
  collideWorld(ent);
}

// ---- Update ---------------------------------------------------------------
function update(g, dt) {
  if (g.status !== 'playing') return;
  g.time += dt;
  // Frame-rate normaliser: all per-frame movement is scaled to a 60fps baseline so
  // the game runs at the same pace on 60/120/144Hz displays (was frame-dependent).
  const f = dt / 16.6667;
  const p = g.player;
  const k = g.keys;

  // Movement (WASD / arrows).
  let mx = 0;
  let my = 0;
  if (k.up) my -= 1;
  if (k.down) my += 1;
  if (k.left) mx -= 1;
  if (k.right) mx += 1;
  if (mx || my) {
    const len = Math.hypot(mx, my) || 1;
    mx /= len; my /= len;
    p.face = { x: mx, y: my };
  }
  const dashing = p.dashTime > 0;
  const jumping = p.jumpTime > 0;
  const running = g.keys.run && !jumping;
  // Run (hold Shift) sprints; dash is a quick burst; jumping keeps lighter control.
  const sp = p.speed * (dashing ? 3.2 : jumping ? 1.25 : running ? 1.75 : 1);
  moveEntity(g, p, mx * sp * f, my * sp * f);
  // Advance the walk cycle in proportion to the distance actually moved this frame,
  // so the legs never out-run the ground — cadence scales naturally with walk/run/dash.
  if (mx || my) p.walkPhase += sp * f * 0.09;
  else p.walkPhase = 0;
  p.jumpTime = Math.max(0, p.jumpTime - dt);

  // Timers.
  p.mp = clamp(p.mp + dt * 0.006, 0, p.maxMp);
  p.atkCd = Math.max(0, p.atkCd - dt);
  p.dashCd = Math.max(0, p.dashCd - dt);
  p.dashTime = Math.max(0, p.dashTime - dt);
  p.hurtCd = Math.max(0, p.hurtCd - dt);
  for (let i = 0; i < 4; i += 1) p.skillCd[i] = Math.max(0, p.skillCd[i] - dt);
  if (g.messageT > 0) g.messageT -= dt;
  g.shake = Math.max(0, g.shake - dt * 0.03);

  updateEnemies(g, dt);
  updateProjectiles(g, dt);
  updateEffects(g, dt);

  // Camera follows the player.
  g.cam.x = clamp(p.x - VIEW_W / 2, 0, WORLD_W - VIEW_W);
  g.cam.y = clamp(p.y - VIEW_H / 2, 0, WORLD_H - VIEW_H);

  if (p.hp <= 0) g.status = 'dead';
}

function gainXp(g, amount) {
  const p = g.player;
  p.xp += amount;
  while (p.xp >= p.xpNext) {
    p.xp -= p.xpNext;
    p.level += 1;
    p.xpNext = Math.round(p.xpNext * 1.5);
    p.maxHp += 14; p.hp = p.maxHp;
    p.maxMp += 6; p.mp = p.maxMp;
    g.message = `Lên cấp ${p.level}!`;
    g.messageT = 1800;
    spawnRing(g, p.x, p.y, 70, '#fde047');
  }
}

function updateEnemies(g, dt) {
  const p = g.player;
  const f = dt / 16.6667; // 60fps movement normaliser (matches update())
  for (const e of g.enemies) {
    if (e.hp <= 0) continue;
    e.atkCd = Math.max(0, e.atkCd - dt);
    const d = dist(e.x, e.y, p.x, p.y);

    if (e.type === 'boss') {
      if (e.dormant) {
        if (d < 360) { e.dormant = false; g.bossActive = true; g.message = 'CORRUPT GUARDIAN thức tỉnh!'; g.messageT = 2400; }
        continue;
      }
      if (e.hp < e.maxHp / 2) e.phase = 2;
      // Chase + periodic radial bullet burst.
      const ang = Math.atan2(p.y - e.y, p.x - e.x);
      moveEntity(g, e, Math.cos(ang) * e.speed * f, Math.sin(ang) * e.speed * f);
      e.slamCd = Math.max(0, (e.slamCd || 0) - dt);
      if (e.slamCd <= 0) {
        e.slamCd = e.phase === 2 ? 3400 : 5000;
        const n = e.phase === 2 ? 12 : 8;
        for (let i = 0; i < n; i += 1) {
          const a = (i / n) * Math.PI * 2;
          g.projectiles.push({ x: e.x, y: e.y, vx: Math.cos(a) * 1.9, vy: Math.sin(a) * 1.9, team: 'enemy', dmg: 12, r: 8, life: 5200, color: '#f472b6' });
        }
      }
      touchDamage(g, e, d);
    } else if (e.type === 'frag') {
      // Keep distance and shoot.
      const ang = Math.atan2(p.y - e.y, p.x - e.x);
      if (d < 220) moveEntity(g, e, -Math.cos(ang) * e.speed * f, -Math.sin(ang) * e.speed * f);
      else if (d > 320) moveEntity(g, e, Math.cos(ang) * e.speed * f, Math.sin(ang) * e.speed * f);
      if (e.atkCd <= 0 && d < 420) {
        e.atkCd = 3600;
        g.projectiles.push({ x: e.x, y: e.y, vx: Math.cos(ang) * 2.0, vy: Math.sin(ang) * 2.0, team: 'enemy', dmg: 9, r: 6, life: 5000, color: '#fb7185' });
      }
    } else {
      // Glitch: charge the player.
      const ang = Math.atan2(p.y - e.y, p.x - e.x);
      moveEntity(g, e, Math.cos(ang) * e.speed * f, Math.sin(ang) * e.speed * f);
      touchDamage(g, e, d);
    }
  }
  // Reap the dead (award XP); detect victory when the boss falls.
  for (const e of g.enemies) {
    if (e.hp <= 0 && !e.dead) {
      e.dead = true;
      gainXp(g, e.xp);
      for (let i = 0; i < 10; i += 1) spawnParticle(g, e.x, e.y, '#a3e635');
      if (e.type === 'boss') { g.status = 'won'; }
    }
  }
  g.enemies = g.enemies.filter((e) => e.hp > 0);
}

function touchDamage(g, e, d) {
  const p = g.player;
  if (d < e.r + p.r && p.hurtCd <= 0 && p.dashTime <= 0) {
    p.hp -= e.contact;
    p.hurtCd = 600;
    g.shake = Math.max(g.shake, e.type === 'boss' ? 9 : 5);
    spawnFloater(g, p.x, p.y - p.r, `-${e.contact}`, '#fca5a5');
  }
}

function updateProjectiles(g, dt) {
  const p = g.player;
  const f = dt / 16.6667; // 60fps movement normaliser (matches update())
  for (const pr of g.projectiles) {
    pr.x += pr.vx * f;
    pr.y += pr.vy * f;
    pr.life -= dt;
    if (blockedByObstacle(g, pr.x, pr.y, pr.r) || pr.x < 0 || pr.y < 0 || pr.x > WORLD_W || pr.y > WORLD_H) pr.life = 0;
    if (pr.team === 'player') {
      for (const e of g.enemies) {
        if (e.hp <= 0 || e.dormant) continue;
        if (dist(pr.x, pr.y, e.x, e.y) < pr.r + e.r) { hurtEnemy(g, e, pr.dmg); pr.life = 0; break; }
      }
    } else if (pr.life > 0 && dist(pr.x, pr.y, p.x, p.y) < pr.r + p.r && p.hurtCd <= 0 && p.dashTime <= 0) {
      p.hp -= pr.dmg; p.hurtCd = 400; pr.life = 0; g.shake = Math.max(g.shake, 4);
      spawnFloater(g, p.x, p.y - p.r, `-${pr.dmg}`, '#fca5a5');
    }
  }
  g.projectiles = g.projectiles.filter((pr) => pr.life > 0);
}

function updateEffects(g, dt) {
  for (const fx of g.effects) {
    fx.life -= dt;
    if (fx.type === 'storm') {
      fx.tick -= dt;
      if (fx.tick <= 0) { fx.tick = 300; aoeDamage(g, fx.x, fx.y, fx.r, fx.dmg); }
    }
  }
  g.effects = g.effects.filter((fx) => fx.life > 0);
  // Particle drift/drag is normalised to 60fps too, so bursts look identical on a
  // 144Hz display instead of scattering twice as fast.
  const f = dt / 16.6667;
  const drag = 0.92 ** f;
  for (const pt of g.particles) { pt.x += pt.vx * f; pt.y += pt.vy * f; pt.life -= dt; pt.vx *= drag; pt.vy *= drag; }
  g.particles = g.particles.filter((pt) => pt.life > 0);
  for (const fl of g.floaters) { fl.y -= dt * 0.03; fl.life -= dt; }
  g.floaters = g.floaters.filter((fl) => fl.life > 0);
}

// ---- Actions (basic attack, dash, skills) ---------------------------------
function basicAttack(g) {
  const p = g.player;
  if (p.atkCd > 0) return;
  p.atkCd = 320;
  const ax = p.x + p.face.x * 28;
  const ay = p.y + p.face.y * 28;
  g.effects.push({ type: 'slash', x: p.x, y: p.y, ang: Math.atan2(p.face.y, p.face.x), r: 44, life: 220, color: '#dbeafe' });
  aoeDamage(g, ax, ay, 30, 14);
}
function dash(g) {
  const p = g.player;
  if (p.dashCd > 0) return;
  p.dashCd = 1100;
  p.dashTime = 160;
  for (let i = 0; i < 8; i += 1) spawnParticle(g, p.x, p.y, '#67e8f9');
}
function jump(g) {
  const p = g.player;
  if (p.jumpTime > 0) return;        // already airborne
  p.jumpTime = p.jumpDur;
  for (let i = 0; i < 6; i += 1) spawnParticle(g, p.x, p.y + 14, '#cbd5e1'); // kick-up dust
}
function castSkill(g, i) {
  const p = g.player;
  const s = SKILLS[i];
  if (p.skillCd[i] > 0 || p.mp < s.mp) return;
  p.mp -= s.mp;
  p.skillCd[i] = s.cd;
  s.cast(g);
}

// ---- Render ---------------------------------------------------------------
// Stable per-tile pseudo-random for scattering ground detail.
function hash2(x, y) {
  let n = (x * 374761393 + y * 668265263) | 0;
  n = ((n ^ (n >> 13)) * 1274126177) | 0;
  return ((n ^ (n >> 16)) >>> 0) / 4294967295;
}

function drawShadow(ctx, x, y, rx) {
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(x, y, rx, rx * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawGround(ctx, g) {
  const T = 64;
  const { cam } = g;
  const x0 = Math.floor(cam.x / T) - 1;
  const x1 = Math.ceil((cam.x + VIEW_W) / T) + 1;
  const y0 = Math.floor(cam.y / T) - 1;
  const y1 = Math.ceil((cam.y + VIEW_H) / T) + 1;
  for (let ty = y0; ty < y1; ty += 1) {
    for (let tx = x0; tx < x1; tx += 1) {
      if (tx < 0 || ty < 0 || tx * T >= WORLD_W || ty * T >= WORLD_H) continue;
      ctx.fillStyle = (tx + ty) % 2 ? '#1d3b2b' : '#21422f';
      ctx.fillRect(tx * T, ty * T, T, T);
      const h = hash2(tx, ty);
      const px = tx * T + 8 + h * (T - 16);
      const py = ty * T + 10 + ((h * 53) % 1) * (T - 20);
      if (h < 0.08) { // flower
        ctx.fillStyle = '#16341f'; ctx.fillRect(px + 1, py, 2, 7);
        ctx.fillStyle = ['#f9a8d4', '#fcd34d', '#a5f3fc'][Math.floor(h * 37) % 3];
        ctx.fillRect(px - 1, py - 3, 6, 4);
      } else if (h < 0.5) { // grass blades
        ctx.strokeStyle = 'rgba(120,200,140,0.35)'; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, py + 6); ctx.lineTo(px + 2, py);
        ctx.moveTo(px + 4, py + 6); ctx.lineTo(px + 6, py - 1);
        ctx.moveTo(px + 8, py + 6); ctx.lineTo(px + 9, py + 1);
        ctx.stroke();
      } else if (h < 0.58) { // pebble
        ctx.fillStyle = '#3f4b44'; ctx.beginPath(); ctx.arc(px + 3, py + 3, 3, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  // Soft inner border (forest edge).
  ctx.strokeStyle = 'rgba(15,40,24,0.8)'; ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, WORLD_W - 10, WORLD_H - 10);
}

function drawObstacle(ctx, o, time) {
  const [x, y, w, h, type] = o;
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath(); ctx.ellipse(cx, y + h - 4, w * 0.5, 9, 0, 0, Math.PI * 2); ctx.fill();
  if (type === 'tree') {
    ctx.fillStyle = '#5b3a1e'; ctx.fillRect(cx - 7, cy, 14, h / 2);
    ctx.fillStyle = '#3f2812'; ctx.fillRect(cx - 7, cy, 4, h / 2);
    const r = Math.min(w, h) * 0.5;
    const sway = Math.sin(time * 0.0012 + x) * 2;
    const clumps = [[cx + sway, y + r * 0.9, r], [cx - r * 0.7 + sway, y + r * 1.3, r * 0.8], [cx + r * 0.7 + sway, y + r * 1.3, r * 0.8]];
    for (const [fx, fy, fr] of clumps) { ctx.fillStyle = '#14532d'; ctx.beginPath(); ctx.arc(fx, fy, fr, 0, Math.PI * 2); ctx.fill(); }
    for (const [fx, fy, fr] of clumps) { ctx.fillStyle = '#22c55e'; ctx.beginPath(); ctx.arc(fx - fr * 0.28, fy - fr * 0.28, fr * 0.55, 0, Math.PI * 2); ctx.fill(); }
  } else if (type === 'rock') {
    const grad = ctx.createLinearGradient(x, y, x, y + h);
    grad.addColorStop(0, '#9ca3af'); grad.addColorStop(1, '#4b5563');
    ctx.fillStyle = grad; ctx.strokeStyle = '#374151'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(cx, cy + h * 0.12, w * 0.5, h * 0.44, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#d1d5db';
    ctx.beginPath(); ctx.ellipse(cx - w * 0.16, cy - h * 0.08, w * 0.18, h * 0.13, 0, 0, Math.PI * 2); ctx.fill();
  } else { // bush
    const n = Math.max(2, Math.round(w / 44));
    for (let i = 0; i < n; i += 1) { const bx = x + (i + 0.5) * (w / n); const by = cy + Math.sin(i * 1.7) * 6; ctx.fillStyle = '#15803d'; ctx.beginPath(); ctx.arc(bx, by, h * 0.46, 0, Math.PI * 2); ctx.fill(); }
    for (let i = 0; i < n; i += 1) { const bx = x + (i + 0.5) * (w / n); const by = cy + Math.sin(i * 1.7) * 6; ctx.fillStyle = '#4ade80'; ctx.beginPath(); ctx.arc(bx - 3, by - 4, h * 0.22, 0, Math.PI * 2); ctx.fill(); }
  }
}

function drawShard(ctx, x, y, time) {
  ctx.save();
  ctx.globalAlpha = 0.14 + Math.sin(time * 0.005) * 0.05;
  ctx.fillStyle = '#fde047';
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2 + time * 0.0008;
    ctx.beginPath(); ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * 64, y + Math.sin(a) * 64);
    ctx.lineTo(x + Math.cos(a + 0.12) * 64, y + Math.sin(a + 0.12) * 64);
    ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.shadowColor = '#fde047'; ctx.shadowBlur = 20;
  const s = 15 + Math.sin(time * 0.006) * 2;
  const grad = ctx.createLinearGradient(x, y - s, x, y + s);
  grad.addColorStop(0, '#fffbe6'); grad.addColorStop(1, '#f59e0b');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.7, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s * 0.7, y); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// Cel-shaded oval: dark outline, base, lower-right shade, upper-left highlight —
// the chunky chibi-RPG look from the reference art.
function oval(ctx, x, y, rx, ry, base, hi, shade, outline) {
  ctx.fillStyle = outline; ctx.beginPath(); ctx.ellipse(x, y, rx + 1.6, ry + 1.6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = shade; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = base; ctx.beginPath(); ctx.ellipse(x - rx * 0.12, y - ry * 0.14, rx * 0.9, ry * 0.9, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = hi; ctx.beginPath(); ctx.ellipse(x - rx * 0.34, y - ry * 0.4, rx * 0.4, ry * 0.3, -0.5, 0, Math.PI * 2); ctx.fill();
}

// The swordsman's steel longsword, held to the `dir` side and angled upward.
function drawHeroSword(ctx, x, y, dir, flash) {
  ctx.save();
  ctx.translate(x, y); ctx.scale(dir, 1); ctx.rotate(-0.45);
  ctx.fillStyle = '#5b3a1e'; ctx.fillRect(-2.5, 0, 5, 10); // grip
  ctx.fillStyle = '#8b5a2b'; ctx.beginPath(); ctx.arc(0, 11, 2.6, 0, Math.PI * 2); ctx.fill(); // pommel
  ctx.fillStyle = '#d4b25a'; ctx.strokeStyle = '#7c5a14'; ctx.lineWidth = 1; ctx.fillRect(-6, -2, 12, 3.6); ctx.strokeRect(-6, -2, 12, 3.6); // guard
  ctx.shadowColor = '#cfe9ff'; ctx.shadowBlur = 8;
  const bg = ctx.createLinearGradient(-4, 0, 4, 0);
  bg.addColorStop(0, '#94a3b8'); bg.addColorStop(0.5, '#f8fafc'); bg.addColorStop(1, '#cbd5e1');
  ctx.fillStyle = flash ? '#fff' : bg; ctx.strokeStyle = '#475569'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(-3, -2); ctx.lineTo(3, -2); ctx.lineTo(2.2, -26); ctx.lineTo(0, -31); ctx.lineTo(-2.2, -26); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(0, -26); ctx.stroke(); // fuller
  ctx.restore();
}

// Sprite sheet extracted from avatar.jpg → public/sprites/echo.png. Four animation
// states, one per row; layout (y/h) printed by scripts/extract-hero-sprite.mjs, the
// per-row `face` (native facing, -1 left / +1 right) set by eye from the art. Each
// row is feet-aligned; `scale` maps source pixels → on-screen size (jump is taller).
const HERO_SP = {
  cw: 125, cols: 5, scale: 0.32,
  rows: [
    { name: 'idle', y: 0, h: 195, face: 1 },     // src row 0 — standing  (art faces right)
    { name: 'walk', y: 195, h: 201, face: 1 },   // src row 1 — walking   (art faces right)
    { name: 'run', y: 396, h: 188, face: 1 },    // src row 2 — running   (art faces right)
    { name: 'jump', y: 584, h: 280, face: 1 },   // src row 3 — jumping   (art faces right)
  ],
};
const HERO_STATE = { idle: 0, walk: 1, run: 2, jump: 3 };

// Draw Echo. Prefers the real avatar.jpg sprite; falls back to the vector chibi if
// the PNG hasn't loaded yet (or failed to).
function drawHero(ctx, g, img) {
  if (img) drawHeroSprite(ctx, g, img);
  else drawHeroVector(ctx, g);
}

// Render the avatar sprite. Choose the row from the player's motion state
// (jump > dash/run > walk > idle), pick a frame, anchor the feet at the player
// (raised by the jump arc), and mirror horizontally to face the movement direction.
function drawHeroSprite(ctx, g, img) {
  const p = g.player;
  const moving = g.keys.up || g.keys.down || g.keys.left || g.keys.right;
  const dashing = p.dashTime > 0;
  const running = g.keys.run && p.jumpTime <= 0;
  const jumping = p.jumpTime > 0;
  const dir = p.face.x < 0 ? -1 : 1;
  const wp = p.walkPhase || 0;

  let state;
  if (jumping) state = HERO_STATE.jump;
  else if (dashing || (moving && running)) state = HERO_STATE.run;
  else if (moving) state = HERO_STATE.walk;
  else state = HERO_STATE.idle;
  const row = HERO_SP.rows[state];

  // Frame within the row.
  let frame;
  if (state === HERO_STATE.jump) {
    const prog = 1 - p.jumpTime / p.jumpDur;             // play the arc once, start→land
    frame = clamp(Math.floor(prog * HERO_SP.cols), 0, HERO_SP.cols - 1);
  } else if (state === HERO_STATE.idle) {
    frame = Math.floor(g.time / 180) % HERO_SP.cols;     // slow breathing loop
  } else {
    frame = Math.floor(wp / (state === HERO_STATE.run ? 0.7 : 0.9)) % HERO_SP.cols;
  }

  const drawW = HERO_SP.cw * HERO_SP.scale;
  const drawH = row.h * HERO_SP.scale;
  const jumpLift = jumping ? Math.sin((1 - p.jumpTime / p.jumpDur) * Math.PI) * 26 : 0;
  const bob = jumping ? 0 : (moving ? Math.abs(Math.sin(wp)) * 1.3 : Math.sin(g.time * 0.004) * 0.8);
  const footY = p.y + 16 - jumpLift - bob;               // feet anchor, raised mid-jump
  const sx = frame * HERO_SP.cw;

  drawShadow(ctx, p.x, p.y + 15, Math.max(7, (moving ? 15 : 13) - jumpLift * 0.28));
  // Draw one feet-anchored copy centred on (cx, cy-offset). Translating by BOTH axes
  // keeps the mirror flip (scale(-1,1)) pivoting on the sprite's own centre — a
  // y-only-absolute `top` would be flipped about the world origin instead.
  const blit = (cx, cy) => {
    ctx.save();
    ctx.translate(cx, cy);
    if (dir !== row.face) ctx.scale(-1, 1);
    ctx.drawImage(img, sx, row.y, HERO_SP.cw, row.h, -drawW / 2, -drawH, drawW, drawH);
    ctx.restore();
  };
  // Dash afterimages: faint ghost copies trailing the motion.
  if (dashing) {
    ctx.globalAlpha = 0.16;
    for (let i = 1; i <= 2; i += 1) blit(p.x - p.face.x * 11 * i, footY - p.face.y * 11 * i);
    ctx.globalAlpha = 1;
  }
  blit(p.x, footY);
}

// Vector fallback — a chibi adventurer matching avatar.jpg (teal coat, dark-red shirt,
// black spiky hair) with a hand-animated walk cycle. Used only until the PNG loads.
function drawHeroVector(ctx, g) {
  const p = g.player;
  const moving = g.keys.up || g.keys.down || g.keys.left || g.keys.right;
  const wp = p.walkPhase || 0;
  const swing = moving ? Math.sin(wp) : 0;                 // limb scissor amount
  const bob = moving ? Math.abs(Math.cos(wp)) * 1.8 : Math.sin(g.time * 0.004) * 0.7;
  const x = p.x;
  const y = p.y + bob - 4;
  const flash = p.hurtCd > 320;
  const dir = p.face.x < 0 ? -1 : 1;
  const O = '#13161f';                                     // cool dark outline
  // Palette sampled from avatar.jpg.
  const coat = flash ? '#fff' : '#1f7a8c'; const coatHi = '#46b3c2'; const coatSh = '#13565f';
  const shirt = flash ? '#fff' : '#7c1d2b'; const shirtHi = '#a83246'; const shirtSh = '#561019';
  const pant = '#2b303c'; const pantHi = '#3d4452'; const pantSh = '#1a1d26';
  const skin = flash ? '#fff' : '#f3c79a'; const skinHi = '#ffe2bf'; const skinSh = '#d49a6a';
  const hair = flash ? '#fff' : '#222a3a'; const hairHi = '#3c4a63';

  drawShadow(ctx, p.x, p.y + 14, 14);

  // Dash afterimages, coat-tinted.
  if (p.dashTime > 0) {
    ctx.globalAlpha = 0.18;
    for (let i = 1; i <= 2; i += 1) oval(ctx, x - p.face.x * 10 * i, y - p.face.y * 10 * i + 6, 8, 11, coat, coatHi, coatSh, O);
    ctx.globalAlpha = 1;
  }

  // ---- Legs (scissor: front + back swap forward/back, lifting on the forward step).
  const fFoot = x + dir * (2 + swing * 4);
  const bFoot = x - dir * (2 + swing * 4);
  const fLift = Math.max(0, swing) * 3;
  const bLift = Math.max(0, -swing) * 3;
  oval(ctx, bFoot, y + 13 - bLift, 2.8, 5.2, pant, pantHi, pantSh, O);
  oval(ctx, bFoot, y + 17 - bLift, 3.4, 3, '#15171d', '#2b2f3a', '#0c0d12', O);   // boot
  oval(ctx, fFoot, y + 13 - fLift, 3, 5.4, pant, pantHi, pantSh, O);
  oval(ctx, fFoot, y + 17 - fLift, 3.6, 3.2, '#1b1e26', '#33384a', '#0e0f15', O); // boot

  // ---- Back arm (anti-phase to the front leg), tucked behind the body.
  oval(ctx, x - dir * 7, y + 4 + swing * 3, 2.8, 5.4, coatSh, coat, '#0e454c', O);

  // ---- Coat tails: a teal skirt that flares opposite the movement and sways.
  const flare = (moving ? -dir * 4 : 0) + Math.sin(g.time * 0.006) * 2;
  ctx.fillStyle = flash ? '#fff' : coatSh;
  ctx.beginPath();
  ctx.moveTo(x - 8, y + 1); ctx.lineTo(x + 8, y + 1);
  ctx.lineTo(x + 7 + flare, y + 16); ctx.lineTo(x + flare * 0.6, y + 20); ctx.lineTo(x - 7 + flare, y + 16);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = O; ctx.lineWidth = 1.4; ctx.stroke();

  // ---- Torso: dark-red shirt under the coat.
  oval(ctx, x, y + 6, 7, 9, shirt, shirtHi, shirtSh, O);

  // ---- Open teal coat (two front panels framing the shirt) + collar.
  ctx.fillStyle = flash ? '#fff' : coat; ctx.strokeStyle = O; ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.moveTo(x - 8, y - 2); ctx.lineTo(x - 2, y + 2); ctx.lineTo(x - 3, y + 16); ctx.lineTo(x - 8.5, y + 14); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + 8, y - 2); ctx.lineTo(x + 2, y + 2); ctx.lineTo(x + 3, y + 16); ctx.lineTo(x + 8.5, y + 14); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = coatHi; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x - 2, y + 2); ctx.lineTo(x - 3, y + 16); ctx.moveTo(x + 2, y + 2); ctx.lineTo(x + 3, y + 16); ctx.stroke();
  ctx.fillStyle = coatHi;
  ctx.beginPath(); ctx.moveTo(x - 6, y - 3); ctx.lineTo(x, y + 1); ctx.lineTo(x + 6, y - 3); ctx.lineTo(x + 3, y - 6); ctx.lineTo(x - 3, y - 6); ctx.closePath(); ctx.fill();

  // ---- Front arm + hand (anti-phase to the back arm).
  const faY = y + 4 - swing * 3;
  oval(ctx, x + dir * 7, faY, 2.8, 5.2, coat, coatHi, coatSh, O);
  oval(ctx, x + dir * 7.6, faY + 5, 2.4, 2.4, skin, skinHi, skinSh, O);
  // Sword flick only during a basic attack — the avatar carries no weapon at rest.
  if (p.atkCd > 140) drawHeroSword(ctx, x + dir * 9, faY + 2, dir, flash);

  // ---- Big chibi head — face first, then black spiky hair.
  const hy = y - 10;
  oval(ctx, x + dir * 1, hy + 1, 9.5, 9.8, skin, skinHi, skinSh, O);
  ctx.fillStyle = hair;
  ctx.beginPath();
  ctx.moveTo(x - 11, hy + 2);
  ctx.lineTo(x - 10, hy - 6); ctx.lineTo(x - 7, hy - 1); ctx.lineTo(x - 5, hy - 11);
  ctx.lineTo(x - 2, hy - 2); ctx.lineTo(x, hy - 12); ctx.lineTo(x + 2.5, hy - 3);
  ctx.lineTo(x + 5, hy - 11); ctx.lineTo(x + 7, hy - 2); ctx.lineTo(x + 10, hy - 6); ctx.lineTo(x + 11, hy + 2);
  ctx.lineTo(x + 8, hy); ctx.lineTo(x + 3, hy - 3);
  ctx.quadraticCurveTo(x + dir * 1, hy - 1, x - 3, hy - 3);
  ctx.lineTo(x - 8, hy); ctx.closePath();
  ctx.fill(); ctx.strokeStyle = O; ctx.lineWidth = 1.4; ctx.stroke();
  // Hair sheen strands.
  ctx.fillStyle = hairHi;
  ctx.beginPath(); ctx.moveTo(x - 5, hy - 10); ctx.lineTo(x - 3.5, hy - 3); ctx.lineTo(x - 2, hy - 9); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x + 4, hy - 10); ctx.lineTo(x + 5.5, hy - 4); ctx.lineTo(x + 7, hy - 8); ctx.closePath(); ctx.fill();
  // Eyes (look toward facing) + brows.
  const ex = x + dir * 1.5;
  ctx.fillStyle = O;
  ctx.fillRect(ex - 4.6, hy + 1, 2.2, 3.4); ctx.fillRect(ex + 2.4, hy + 1, 2.2, 3.4);
  ctx.fillStyle = '#9bd4ff';
  ctx.fillRect(ex - 4.2, hy + 1.4, 1, 1.4); ctx.fillRect(ex + 2.8, hy + 1.4, 1, 1.4);
  ctx.strokeStyle = O; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(ex - 5.2, hy - 0.4); ctx.lineTo(ex - 2.2, hy + 0.2); ctx.moveTo(ex + 2.2, hy + 0.2); ctx.lineTo(ex + 5.2, hy - 0.4); ctx.stroke();
}

// Cute corrupted slime (chromatic-glitch accent + big eye + little feet).
function drawGlitch(ctx, e, time) {
  const j = Math.sin(time * 0.02 + e.x) * 1.3;
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = '#22d3ee'; ctx.beginPath(); ctx.arc(e.x - 2 + j, e.y, e.r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#f43f5e'; ctx.beginPath(); ctx.arc(e.x + 2 - j, e.y, e.r, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
  oval(ctx, e.x, e.y + 1, e.r, e.r * 0.92, '#84cc16', '#d9f99d', '#3f6212', '#16270a');
  ctx.fillStyle = '#bef264'; ctx.fillRect(e.x - e.r, e.y - 2 + j, e.r * 2, 2); // glitch bar
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(e.x + 1, e.y - 1, e.r * 0.44, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#15240a'; ctx.beginPath(); ctx.arc(e.x + 2.5, e.y - 1, e.r * 0.22, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(e.x + 1.6, e.y - 2.4, e.r * 0.09, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#3f6212'; ctx.fillRect(e.x - 6, e.y + e.r - 1, 3.5, 3); ctx.fillRect(e.x + 2.5, e.y + e.r - 1, 3.5, 3);
}

// Floating crystal critter (cluster of cel-shaded gems with a tiny eye).
function drawFragment(ctx, e, time) {
  const yb = e.y + Math.sin(time * 0.006 + e.y) * 3;
  const O = '#7f1d3a';
  const diamond = (cx, cy, s) => {
    ctx.fillStyle = O; ctx.beginPath(); ctx.moveTo(cx, cy - s - 1.4); ctx.lineTo(cx + s * 0.72 + 1.4, cy); ctx.lineTo(cx, cy + s + 1.4); ctx.lineTo(cx - s * 0.72 - 1.4, cy); ctx.closePath(); ctx.fill();
    const gg = ctx.createLinearGradient(cx, cy - s, cx, cy + s);
    gg.addColorStop(0, '#fecdd3'); gg.addColorStop(0.5, '#fb7185'); gg.addColorStop(1, '#e11d48');
    ctx.fillStyle = gg; ctx.beginPath(); ctx.moveTo(cx, cy - s); ctx.lineTo(cx + s * 0.72, cy); ctx.lineTo(cx, cy + s); ctx.lineTo(cx - s * 0.72, cy); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.beginPath(); ctx.moveTo(cx, cy - s * 0.6); ctx.lineTo(cx - s * 0.28, cy); ctx.lineTo(cx, cy + s * 0.2); ctx.closePath(); ctx.fill();
  };
  ctx.save(); ctx.shadowColor = '#fb7185'; ctx.shadowBlur = 10;
  diamond(e.x - 6, yb + 3, e.r * 0.5); diamond(e.x + 6, yb + 3, e.r * 0.46); diamond(e.x, yb, e.r);
  ctx.restore();
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(e.x, yb, 2.6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#4c0519'; ctx.beginPath(); ctx.arc(e.x, yb, 1.4, 0, Math.PI * 2); ctx.fill();
}

function drawEnemy(ctx, e, time) {
  drawShadow(ctx, e.x, e.y + e.r * 0.78, e.r * 0.85);
  if (e.type === 'boss') drawBoss(ctx, e, time);
  else if (e.type === 'frag') drawFragment(ctx, e, time);
  else drawGlitch(ctx, e, time);
  if (!e.dormant && e.hp < e.maxHp) {
    const bw = e.r * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(e.x - e.r, e.y - e.r - 12, bw, 5);
    ctx.fillStyle = e.type === 'boss' ? '#ec4899' : '#ef4444'; ctx.fillRect(e.x - e.r, e.y - e.r - 12, bw * (e.hp / e.maxHp), 5);
  }
}

// Corrupt Guardian — a chibi armored golem boss with horns, a glowing visor and
// a glowing greatsword (phase 2 shifts purple → pink).
function drawBoss(ctx, e, time) {
  const p2 = e.phase === 2;
  const dorm = e.dormant;
  const O = '#120d24';
  const eye = dorm ? '#7c3aed' : (p2 ? '#fda4af' : '#e879f9');
  const base = dorm ? '#3b3357' : (p2 ? '#7a2348' : '#42396e');
  const hi = dorm ? '#564d7e' : (p2 ? '#b03a6a' : '#6a5da8');
  const sh = '#201a38';
  const r = e.r;
  if (!dorm) {
    ctx.save(); ctx.globalAlpha = 0.2 + Math.sin(time * 0.01) * 0.1;
    ctx.fillStyle = p2 ? '#ec4899' : '#a855f7';
    ctx.beginPath(); ctx.arc(e.x, e.y, r + 16 + Math.sin(time * 0.01) * 4, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  // Glowing greatsword.
  if (!dorm) {
    ctx.save(); ctx.translate(e.x + r * 0.95, e.y + r * 0.1); ctx.rotate(0.45);
    ctx.shadowColor = p2 ? '#f472b6' : '#c084fc'; ctx.shadowBlur = 16;
    ctx.fillStyle = '#3a2350'; ctx.fillRect(-4, 0, 8, r * 0.7);
    const bg = ctx.createLinearGradient(0, -r * 1.7, 0, r * 0.4);
    bg.addColorStop(0, '#f5d0fe'); bg.addColorStop(1, p2 ? '#db2777' : '#9333ea');
    ctx.fillStyle = bg; ctx.strokeStyle = O; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(-6, r * 0.1); ctx.lineTo(6, r * 0.1); ctx.lineTo(4, -r * 1.4); ctx.lineTo(0, -r * 1.75); ctx.lineTo(-4, -r * 1.4); ctx.closePath();
    ctx.fill(); ctx.stroke(); ctx.restore();
  }
  // Legs.
  oval(ctx, e.x - r * 0.45, e.y + r * 0.72, r * 0.32, r * 0.42, base, hi, sh, O);
  oval(ctx, e.x + r * 0.45, e.y + r * 0.72, r * 0.32, r * 0.42, base, hi, sh, O);
  // Torso.
  oval(ctx, e.x, e.y + r * 0.12, r * 0.82, r * 0.92, base, hi, sh, O);
  // Chest core.
  ctx.save(); ctx.shadowColor = eye; ctx.shadowBlur = 12; ctx.fillStyle = eye;
  ctx.beginPath(); ctx.arc(e.x, e.y + r * 0.1, r * 0.17, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  // Pauldrons.
  oval(ctx, e.x - r * 0.82, e.y - r * 0.28, r * 0.4, r * 0.38, hi, '#cbd5e1', sh, O);
  oval(ctx, e.x + r * 0.82, e.y - r * 0.28, r * 0.4, r * 0.38, hi, '#cbd5e1', sh, O);
  // Helm.
  oval(ctx, e.x, e.y - r * 0.55, r * 0.5, r * 0.46, base, hi, sh, O);
  // Horns.
  ctx.fillStyle = O;
  ctx.beginPath(); ctx.moveTo(e.x - r * 0.45, e.y - r * 0.82); ctx.lineTo(e.x - r * 0.95, e.y - r * 1.3); ctx.lineTo(e.x - r * 0.28, e.y - r * 0.72); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(e.x + r * 0.45, e.y - r * 0.82); ctx.lineTo(e.x + r * 0.95, e.y - r * 1.3); ctx.lineTo(e.x + r * 0.28, e.y - r * 0.72); ctx.closePath(); ctx.fill();
  // Glowing visor eyes.
  ctx.save(); ctx.shadowColor = eye; ctx.shadowBlur = 12; ctx.fillStyle = eye;
  ctx.fillRect(e.x - r * 0.34, e.y - r * 0.62, r * 0.24, r * 0.12);
  ctx.fillRect(e.x + r * 0.1, e.y - r * 0.62, r * 0.24, r * 0.12);
  ctx.restore();
}

function render(ctx, g, heroImg) {
  const { cam } = g;
  const shx = g.shake ? (Math.random() - 0.5) * g.shake : 0;
  const shy = g.shake ? (Math.random() - 0.5) * g.shake : 0;
  const time = g.time;

  // Base ground gradient (screen space).
  const bg = ctx.createLinearGradient(0, 0, 0, VIEW_H);
  bg.addColorStop(0, '#1b3a2a'); bg.addColorStop(1, '#0e2018');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  ctx.save();
  ctx.translate(-cam.x + shx, -cam.y + shy);

  drawGround(ctx, g);
  if (g.boss && g.boss.hp > 0) drawShard(ctx, WORLD_W - 80, WORLD_H / 2, time);

  // Storms (under everything).
  for (const fx of g.effects) {
    if (fx.type !== 'storm') continue;
    ctx.save();
    const grad = ctx.createRadialGradient(fx.x, fx.y, 4, fx.x, fx.y, fx.r);
    grad.addColorStop(0, 'rgba(196,181,253,0.55)'); grad.addColorStop(1, 'rgba(124,58,237,0)');
    ctx.globalAlpha = clamp(fx.life / 2200, 0, 1);
    ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(fx.x, fx.y, fx.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(221,214,254,0.6)'; ctx.lineWidth = 2;
    for (let i = 0; i < 3; i += 1) { ctx.beginPath(); ctx.arc(fx.x, fx.y, fx.r * 0.35 + i * 14, time * 0.01 + i, time * 0.01 + i + 2.2); ctx.stroke(); }
    ctx.restore();
  }

  for (const o of g.obstacles) drawObstacle(ctx, o, time);
  for (const e of g.enemies) drawEnemy(ctx, e, time);

  // Projectiles (glowing).
  for (const pr of g.projectiles) {
    ctx.save(); ctx.shadowColor = pr.color; ctx.shadowBlur = 12; ctx.fillStyle = pr.color;
    ctx.beginPath(); ctx.arc(pr.x, pr.y, pr.r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.beginPath(); ctx.arc(pr.x, pr.y, pr.r * 0.45, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  drawHero(ctx, g, heroImg);

  // Rings & slashes.
  for (const fx of g.effects) {
    if (fx.type === 'ring') {
      ctx.strokeStyle = fx.color; ctx.globalAlpha = clamp(fx.life / 360, 0, 1); ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(fx.x, fx.y, fx.r * (1.1 - fx.life / 720), 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (fx.type === 'slash') {
      const prog = 1 - fx.life / 220;
      ctx.save();
      ctx.globalAlpha = clamp(fx.life / 220, 0, 1);
      ctx.strokeStyle = fx.color; ctx.lineWidth = 7; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(fx.x, fx.y, fx.r, fx.ang - 1.1 + prog * 0.6, fx.ang + 0.4 + prog * 0.6); ctx.stroke();
      ctx.restore();
    }
  }
  // Particles.
  for (const pt of g.particles) { ctx.globalAlpha = clamp(pt.life / 400, 0, 1); ctx.fillStyle = pt.color; ctx.fillRect(pt.x - 2, pt.y - 2, 4, 4); }
  ctx.globalAlpha = 1;
  // Fireflies / motes.
  ctx.fillStyle = '#fde68a';
  for (const m of g.motes) {
    const mx = m.x + Math.sin(time * 0.001 * m.sp + m.ph) * 12;
    const my = m.y + Math.cos(time * 0.0012 * m.sp + m.ph) * 12;
    ctx.globalAlpha = 0.25 + Math.sin(time * 0.003 + m.ph) * 0.2;
    ctx.fillRect(mx, my, 2, 2);
  }
  ctx.globalAlpha = 1;
  // Floaters.
  ctx.font = 'bold 15px monospace'; ctx.textAlign = 'center';
  for (const fl of g.floaters) {
    ctx.globalAlpha = clamp(fl.life / 700, 0, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillText(fl.text, fl.x + 1, fl.y + 1);
    ctx.fillStyle = fl.color; ctx.fillText(fl.text, fl.x, fl.y);
  }
  ctx.globalAlpha = 1;

  ctx.restore();
}

// Hex (#rrggbb) → rgba() string for additive glow halos.
function hexGlow(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Bloom pass: draw soft additive halos for every emissive source onto an
// offscreen layer; the caller blurs + adds it over the scene for a modern glow.
function renderGlow(c, g) {
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, VIEW_W, VIEW_H);
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.translate(-g.cam.x, -g.cam.y);
  const halo = (x, y, r, col) => {
    const gr = c.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = gr; c.fillRect(x - r, y - r, r * 2, r * 2);
  };
  if (g.boss && g.boss.hp > 0) halo(WORLD_W - 80, WORLD_H / 2, 110, 'rgba(253,224,71,0.85)');
  halo(g.player.x, g.player.y - 2, 46, 'rgba(207,233,255,0.22)');
  for (const pr of g.projectiles) halo(pr.x, pr.y, pr.r * 4.5, hexGlow(pr.color, 0.85));
  for (const e of g.enemies) {
    if (e.type === 'boss') { if (!e.dormant) halo(e.x, e.y, e.r * 2.6, e.phase === 2 ? 'rgba(236,72,153,0.6)' : 'rgba(168,85,247,0.5)'); }
    else if (e.type === 'frag') halo(e.x, e.y, e.r * 2.4, 'rgba(251,113,133,0.5)');
    else halo(e.x, e.y, e.r * 1.8, 'rgba(132,204,22,0.32)');
  }
  for (const f of g.effects) {
    if (f.type === 'ring') halo(f.x, f.y, f.r * 1.3, hexGlow(f.color, 0.55));
    else if (f.type === 'storm') halo(f.x, f.y, f.r, 'rgba(167,139,250,0.5)');
    else if (f.type === 'slash') halo(f.x, f.y, f.r * 1.1, 'rgba(219,234,254,0.45)');
  }
  c.restore();
}

function drawVignette(ctx) {
  const vg = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.42, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.9);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  // Subtle warm/cool colour grade.
  ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = 0.12;
  const cg = ctx.createLinearGradient(0, 0, VIEW_W, VIEW_H);
  cg.addColorStop(0, '#1d4ed8'); cg.addColorStop(1, '#f59e0b');
  ctx.fillStyle = cg; ctx.fillRect(0, 0, VIEW_W, VIEW_H); ctx.restore();
}

// ---- React component ------------------------------------------------------
export default function RpgGame({ onExit }) {
  const { t } = useTranslation();
  const canvasRef = useRef(null);
  const gameRef = useRef(null);
  const [hud, setHud] = useState(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);

  function loadBest() {
    try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || {}; } catch { return {}; }
  }
  const [best, setBest] = useState(loadBest);

  function start() {
    gameRef.current = createGame(1);
    setPaused(false); pausedRef.current = false;
  }

  useEffect(() => {
    start();
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    // Offscreen layer for the additive bloom pass.
    const fxCanvas = document.createElement('canvas');
    fxCanvas.width = VIEW_W; fxCanvas.height = VIEW_H;
    const fxCtx = fxCanvas.getContext('2d');
    const canBlur = (() => { try { ctx.filter = 'blur(1px)'; const ok = ctx.filter !== 'none'; ctx.filter = 'none'; return ok; } catch { return false; } })();
    // Real avatar.jpg sprite sheet; render falls back to the vector chibi until it loads.
    const heroImg = new Image();
    let heroReady = false;
    heroImg.onload = () => { heroReady = true; };
    heroImg.src = '/sprites/echo.png';
    let raf;
    let last = performance.now();
    let hudT = 0;
    let running = true;

    const KEYMAP = {
      w: 'up', a: 'left', s: 'down', d: 'right',
      arrowup: 'up', arrowleft: 'left', arrowdown: 'down', arrowright: 'right',
    };
    const ACTION_KEYS = ['j', ' ', 'k', 'u', 'i', 'o', 'p', 'escape', 'enter'];
    const onKeyDown = (e) => {
      const g = gameRef.current;
      if (!g) return;
      const key = e.key.toLowerCase();
      if (KEYMAP[key]) g.keys[KEYMAP[key]] = true;
      if (key === 'shift') g.keys.run = true;            // hold to run
      if (KEYMAP[key] || ACTION_KEYS.includes(key)) e.preventDefault(); // stop page scroll/focus
      // Esc toggles pause, so the same key that paused also resumes.
      if (key === 'escape' && g.status === 'playing') {
        const next = !pausedRef.current;
        pausedRef.current = next; setPaused(next);
        return;
      }
      if (g.status !== 'playing' || pausedRef.current) {
        if (key === 'enter' && g.status !== 'playing') start();
        return;
      }
      if (key === 'j') basicAttack(g);
      else if (key === ' ') jump(g);
      else if (key === 'k') dash(g);
      else if (key === 'u') castSkill(g, 0);
      else if (key === 'i') castSkill(g, 1);
      else if (key === 'o') castSkill(g, 2);
      else if (key === 'p') castSkill(g, 3);
    };
    const onKeyUp = (e) => {
      const g = gameRef.current;
      const key = e.key.toLowerCase();
      const m = KEYMAP[key];
      if (m && g) g.keys[m] = false;
      if (key === 'shift' && g) g.keys.run = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    const loop = (now) => {
      if (!running) return;
      const dt = Math.min(48, now - last);
      last = now;
      const g = gameRef.current;
      if (!pausedRef.current) update(g, dt);
      render(ctx, g, heroReady ? heroImg : null);
      // Bloom: blur the emissive layer and add it over the scene, then vignette.
      renderGlow(fxCtx, g);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.9;
      if (canBlur) ctx.filter = 'blur(5px)';
      ctx.drawImage(fxCanvas, 0, 0);
      ctx.filter = 'none';
      ctx.restore();
      drawVignette(ctx);
      // Persist best progress once per run — the end overlay stays up for many
      // frames, so `saved` keeps this off the 60fps path.
      if ((g.status === 'won' || g.status === 'dead') && !g.saved) {
        g.saved = true;
        const prev = loadBest();
        const next = { bestLevel: Math.max(prev.bestLevel || 0, g.player.level), cleared: prev.cleared || g.status === 'won' };
        try { localStorage.setItem(SAVE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
        setBest(next);
      }
      hudT -= dt;
      if (hudT <= 0) {
        hudT = 90;
        const p = g.player;
        setHud({
          hp: Math.ceil(p.hp), maxHp: p.maxHp, mp: Math.floor(p.mp), maxMp: p.maxMp,
          level: p.level, xp: p.xp, xpNext: p.xpNext,
          cds: p.skillCd.map((c, i) => (c > 0 ? c / SKILLS[i].cd : 0)),
          mpNow: p.mp, status: g.status,
          message: g.messageT > 0 ? g.message : '',
          boss: g.bossActive && g.boss && g.boss.hp > 0 ? { hp: g.boss.hp, max: g.boss.maxHp } : null,
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const resume = () => { pausedRef.current = false; setPaused(false); };

  return (
    <div className="mx-auto w-full max-w-[860px]">
      <div className="mb-2 flex items-center gap-3">
        <button onClick={onExit} className="btn-secondary py-1.5 text-sm">{t('games.rpg.exit')}</button>
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t('games.catalog.rpg')}</span>
        {best.cleared && <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">★ {t('games.rpg.cleared')}</span>}
        <span className="ml-auto text-xs text-slate-400">{t('games.rpg.controls')}</span>
      </div>

      <div className="relative overflow-hidden rounded-lg border-2 border-slate-700 bg-[#16241b] shadow-md">
        <canvas ref={canvasRef} width={VIEW_W} height={VIEW_H} className="block w-full" style={{ aspectRatio: `${VIEW_W} / ${VIEW_H}` }} />

        {/* Boss HP bar */}
        {hud?.boss && (
          <div className="absolute inset-x-6 top-2">
            <div className="mb-0.5 text-center text-xs font-bold text-pink-200 drop-shadow">CORRUPT GUARDIAN</div>
            <div className="h-2.5 w-full overflow-hidden rounded bg-black/50">
              <div className="h-full bg-pink-500" style={{ width: `${(hud.boss.hp / hud.boss.max) * 100}%` }} />
            </div>
          </div>
        )}

        {/* Center message */}
        {hud?.message && hud.status === 'playing' && (
          <div className="pointer-events-none absolute inset-x-0 top-16 text-center text-lg font-bold text-yellow-300 drop-shadow">{hud.message}</div>
        )}

        {/* HUD bottom-left: HP / MP / level */}
        {hud && (
          <div className="absolute bottom-2 left-2 w-48 space-y-1">
            <Bar label={`HP ${hud.hp}/${hud.maxHp}`} ratio={hud.hp / hud.maxHp} color="bg-rose-500" />
            <Bar label={`MP ${hud.mp}/${hud.maxMp}`} ratio={hud.mp / hud.maxMp} color="bg-sky-500" />
            <Bar label={`Lv ${hud.level}`} ratio={hud.xp / hud.xpNext} color="bg-amber-400" />
          </div>
        )}

        {/* Skill slots bottom-right */}
        {hud && (
          <div className="absolute bottom-2 right-2 flex gap-1.5">
            {['J', 'K', ...SKILLS.map((s) => s.key)].map((key, i) => {
              const skillIdx = i - 2;
              const cd = skillIdx >= 0 ? hud.cds[skillIdx] : 0;
              const low = skillIdx >= 0 && hud.mpNow < SKILLS[skillIdx].mp;
              return (
                <div key={key} className="relative h-11 w-11 overflow-hidden rounded-md border border-slate-500 bg-slate-800/80 text-center">
                  <div className="pt-0.5 text-[9px] text-slate-300">{i === 0 ? 'ATK' : i === 1 ? 'DASH' : SKILLS[skillIdx].id.toUpperCase().slice(0, 4)}</div>
                  <div className="text-sm font-bold text-white" style={{ color: skillIdx >= 0 ? SKILLS[skillIdx].color : '#fff' }}>{key}</div>
                  {cd > 0 && <div className="absolute inset-x-0 bottom-0 bg-black/70" style={{ height: `${cd * 100}%` }} />}
                  {low && <div className="absolute inset-0 bg-red-900/40" />}
                </div>
              );
            })}
          </div>
        )}

        {/* Overlays */}
        {hud?.status === 'won' && <Overlay title={t('games.rpg.victory')} sub={t('games.rpg.shardGot')} accent="text-emerald-300" onRetry={start} onExit={onExit} t={t} />}
        {hud?.status === 'dead' && <Overlay title={t('games.rpg.defeat')} sub="" accent="text-rose-300" onRetry={start} onExit={onExit} t={t} />}
        {paused && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60">
            <div className="text-2xl font-bold text-white">{t('games.rpg.paused')}</div>
            <button onClick={resume} className="btn-primary">{t('games.rpg.resume')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Bar({ label, ratio, color }) {
  return (
    <div className="relative h-4 overflow-hidden rounded bg-black/50">
      <div className={`h-full ${color}`} style={{ width: `${clamp(ratio, 0, 1) * 100}%` }} />
      <span className="absolute inset-0 px-1 text-[10px] font-bold leading-4 text-white drop-shadow">{label}</span>
    </div>
  );
}

function Overlay({ title, sub, accent, onRetry, onExit, t }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70">
      <div className={`text-3xl font-extrabold ${accent}`}>{title}</div>
      {sub && <div className="text-sm text-slate-200">{sub}</div>}
      <div className="flex gap-2">
        <button onClick={onRetry} className="btn-primary">{t('games.rpg.retry')}</button>
        <button onClick={onExit} className="btn-secondary">{t('games.rpg.exit')}</button>
      </div>
    </div>
  );
}
