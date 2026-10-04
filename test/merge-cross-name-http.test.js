'use strict';

// 交叉重名合并的 HTTP 回归：
// 草稿把灯具（甲）改名「聚光」、待合入版本把另一盏灯具（乙）也改名「聚光」。
// 任一侧单独看名称都合法，只有「交叉组合」重名。预览必须返回两项冲突的令牌、
// 两侧取值与可读缘由（页面可逐项选择），不得再 500；提交时重名组合/未完成抉择
// 整次 400 拒绝且草稿不变，名称唯一的组合一次事务落定。预览后草稿变化 409、
// 已发布快照不变、令牌一次性等既有约定保持不变。
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('node:path');
const http = require('node:http');
const Database = require('better-sqlite3');

// 独立临时库，不触碰开发数据
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-merge-cross-'));
process.env.DB_PATH = path.join(TMP_DIR, 'app.db');
const DB_PATH = process.env.DB_PATH;
const { app } = require('../server.js');

let server;
let port;
const raw = new Database(DB_PATH); // 直连：直接构造草稿与「另一组」已发布版本快照

function httpJson(method, urlPath, body) {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const get = (p) => httpJson('GET', p);
const post = (p, b) => httpJson('POST', p, b);

function hardReset() {
  raw.exec(`
    DELETE FROM record_ops;
    DELETE FROM rehearsal_records;
    DELETE FROM merge_previews;
    DELETE FROM cues;
    DELETE FROM lights;
    DELETE FROM circuits;
    DELETE FROM room_handovers;
    DELETE FROM room_programs;
    DELETE FROM room_stops;
    DELETE FROM room_schedules;
    DELETE FROM rooms;
    DELETE FROM version_cues;
    DELETE FROM version_light_wiring;
    DELETE FROM version_circuits;
    DELETE FROM version_lights;
    DELETE FROM versions;
    DELETE FROM sqlite_sequence;
  `);
}

// 直接写入一份不可变版本快照（不动草稿）
function insertVersion(label, snap) {
  const info = raw
    .prepare('INSERT INTO versions (label, created_at, cue_count) VALUES (?, ?, ?)')
    .run(label, Date.now() / 1000, snap.cues.length);
  const vid = info.lastInsertRowid;
  snap.lights.forEach((l, i) =>
    raw
      .prepare('INSERT INTO version_lights (version_id, light_id, name, pos) VALUES (?, ?, ?, ?)')
      .run(vid, l.id, l.name, i)
  );
  snap.circuits.forEach((c, i) =>
    raw
      .prepare(
        'INSERT INTO version_circuits (version_id, circuit_id, name, capacity, pos) VALUES (?, ?, ?, ?, ?)'
      )
      .run(vid, c.id, c.name, c.capacity, i)
  );
  for (const w of snap.wiring) {
    raw
      .prepare(
        'INSERT INTO version_light_wiring (version_id, light_id, circuit_id, watts) VALUES (?, ?, ?, ?)'
      )
      .run(vid, w.light_id, w.circuit_id, w.watts);
  }
  snap.cues.forEach((c, i) =>
    raw
      .prepare(
        `INSERT INTO version_cues
           (version_id, cue_no, light_id, time, target, duration, pos)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(vid, c.cue_no, c.light_id, c.time, c.target, c.duration, i)
  );
  return vid;
}

// 场景：基线灯具 #1=甲、#2=乙；草稿把 #1 改名「聚光」；待合入版本把 #2 改名「聚光」
function fixture() {
  const wiring = [
    { light_id: 1, circuit_id: null, watts: null },
    { light_id: 2, circuit_id: null, watts: null },
  ];
  const base = {
    lights: [
      { id: 1, name: '甲' },
      { id: 2, name: '乙' },
    ],
    circuits: [],
    cues: [],
    wiring,
  };
  const baseId = insertVersion('共同基线', base);

  const now = Date.now() / 1000;
  raw.prepare('INSERT INTO lights (id, name, created_at) VALUES (?, ?, ?)').run(1, '聚光', now);
  raw.prepare('INSERT INTO lights (id, name, created_at) VALUES (?, ?, ?)').run(2, '乙', now);

  const incoming = {
    lights: [
      { id: 1, name: '甲' },
      { id: 2, name: '聚光' },
    ],
    circuits: [],
    cues: [],
    wiring,
  };
  const incomingId = insertVersion('B组-灯乙改名聚光', incoming);
  return { baseId, incomingId };
}

before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => {
  await new Promise((r) => server.close(r));
  raw.close();
});
beforeEach(() => {
  hardReset();
});

test('预览：两盏灯的交叉重名列为冲突，返回令牌/两侧取值/可读缘由（不再 500）', async () => {
  const { baseId, incomingId } = fixture();

  const pv = await post('/api/merge/preview', {
    base_version_id: baseId,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200, JSON.stringify(pv.json));
  assert.ok(/^[0-9a-f]{24,}$/.test(pv.json.token));
  assert.equal(pv.json.summary.conflicts_total, 2);

  const byKey = Object.fromEntries(pv.json.conflicts.map((c) => [c.key, c]));
  const c1 = byKey['light:1'];
  const c2 = byKey['light:2'];
  assert.ok(c1 && c2);
  for (const c of [c1, c2]) {
    assert.equal(c.reason, 'cross_name_collision');
    assert.equal(c.attached, false);
    assert.ok(c.reason_text.includes('交叉重名'));
    assert.ok(c.reason_text.includes('聚光'));
    // 两侧取值齐备
    assert.ok(c.draft && c.incoming);
    assert.ok(c.reasons.some((r) => r.code === 'cross_name_collision'));
  }
  assert.equal(c1.draft.name, '聚光');
  assert.equal(c1.incoming.name, '甲');
  assert.equal(c2.draft.name, '乙');
  assert.equal(c2.incoming.name, '聚光');
  // 缘由点出与之撞名的另一盏灯
  assert.ok(c1.reason_text.includes('灯具 #2'));
  assert.ok(c2.reason_text.includes('灯具 #1'));
});

test('提交：未完成抉择 → 400 unresolved，草稿不变', async () => {
  const { baseId, incomingId } = fixture();
  const pv = await post('/api/merge/preview', {
    base_version_id: baseId,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200);

  const half = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:1': 'draft' }, // light:2 未选
  });
  assert.equal(half.status, 400);
  assert.deepEqual(half.json.unresolved, ['light:2']);

  const lights = (await get('/api/lights')).json.map((l) => [l.id, l.name]);
  assert.deepEqual(lights, [
    [1, '聚光'],
    [2, '乙'],
  ]);
});

test('提交：交叉重名组合 → 400 violations，草稿不变；合法抉择可凭同一令牌重试', async () => {
  const { baseId, incomingId } = fixture();
  const pv = await post('/api/merge/preview', {
    base_version_id: baseId,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200);

  // #1 草稿（聚光）+ #2 待合入（聚光）→ 仍重名
  const bad = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:1': 'draft', 'light:2': 'incoming' },
  });
  assert.equal(bad.status, 400);
  const keys = bad.json.violations.map((v) => v.key).sort();
  assert.deepEqual(keys, ['light:1', 'light:2']);
  assert.ok(bad.json.violations.every((v) => v.code === 'name_collision'));

  // 草稿未变
  const lightsAfter = (await get('/api/lights')).json.map((l) => l.name);
  assert.deepEqual(lightsAfter, ['聚光', '乙']);

  // 同一令牌可重试合法组合：#1 草稿（聚光）、#2 草稿（乙）
  const ok = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:1': 'draft', 'light:2': 'draft' },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(
    ok.json.draft.lights.map((l) => l.name),
    ['聚光', '乙']
  );

  // 令牌一次性：成功后再用 404
  const again = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:1': 'draft', 'light:2': 'draft' },
  });
  assert.equal(again.status, 404);
});

test('提交：唯一组合（两侧都采用待合入）一次事务落定，已发布快照不变', async () => {
  const { baseId, incomingId } = fixture();
  const pv = await post('/api/merge/preview', {
    base_version_id: baseId,
    incoming_version_id: incomingId,
  });
  const ok = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:1': 'incoming', 'light:2': 'incoming' },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(
    ok.json.draft.lights.map((l) => l.name),
    ['甲', '聚光']
  );

  // 基线/待合入快照均不变
  const baseSnap = (await get(`/api/versions/${baseId}`)).json;
  const incSnap = (await get(`/api/versions/${incomingId}`)).json;
  assert.deepEqual(baseSnap.lights.map((l) => l.name), ['甲', '乙']);
  assert.deepEqual(incSnap.lights.map((l) => l.name), ['甲', '聚光']);
});

test('预览后草稿被编辑 → 提交 409 令牌作废；重新预览后可正常提交', async () => {
  const { baseId, incomingId } = fixture();
  const pv = await post('/api/merge/preview', {
    base_version_id: baseId,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200);

  // 草稿侧再编辑（灯具改名无 HTTP 接口，直连草稿库模拟编辑；任一变化即作废）
  raw.prepare('UPDATE lights SET name = ? WHERE id = ?').run('乙-改', 2);

  const stale = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:1': 'draft', 'light:2': 'draft' },
  });
  assert.equal(stale.status, 409);

  // 旧令牌已删除 → 404
  const reuse = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:1': 'draft', 'light:2': 'draft' },
  });
  assert.equal(reuse.status, 404);

  // 重新预览（此时 #2 草稿侧也是改名 → 结构性冲突，仍可逐项选择并提交）
  const pv2 = await post('/api/merge/preview', {
    base_version_id: baseId,
    incoming_version_id: incomingId,
  });
  assert.equal(pv2.status, 200);
  assert.equal(pv2.json.summary.conflicts_total >= 1, true);
  const ok = await post('/api/merge/commit', {
    token: pv2.json.token,
    // #2 取草稿侧的「乙-改」，与 #1 的「聚光」不重名
    resolutions: Object.fromEntries(pv2.json.conflicts.map((c) => [c.key, 'draft'])),
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(
    ok.json.draft.lights.map((l) => l.name),
    ['聚光', '乙-改']
  );
});
