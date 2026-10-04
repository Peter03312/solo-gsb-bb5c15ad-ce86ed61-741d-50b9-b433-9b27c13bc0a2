'use strict';

// 交叉改名撞名的合并回归（HTTP 全流程）：
// 两组从同一已发布基线各自改稿——草稿把灯具甲改名为「聚光」，待合入版本把另一盏
// 灯具乙也改名为「聚光」。预览必须把两项列为冲突并给出可读缘由（不得报错），
// 页面据两侧取值逐项抉择；名称唯一的组合凭令牌一次事务落定，撞名组合或未完成
// 抉择明确拒绝且草稿不变；预览后草稿变动 409、已发布快照不变、令牌一次性等
// 既有约定保持不变。回路交叉改名同理。
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Database = require('better-sqlite3');

// 独立临时库，不触碰开发数据
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-merge-xrename-'));
process.env.DB_PATH = path.join(TMP_DIR, 'app.db');
const DB_PATH = process.env.DB_PATH;
const { app } = require('../server.js');

let server;
let port;
const raw = new Database(DB_PATH); // 直连：用于构造「另一组」已发布版本快照与草稿改名

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
const put = (p, b) => httpJson('PUT', p, b);

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

// 直接写入一份不可变版本快照（不动草稿），模拟另一组排演人员发布的版本
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
  snap.cues.forEach((c, i) =>
    raw
      .prepare(
        `INSERT INTO version_cues
           (version_id, cue_no, light_id, time, target, duration, pos)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(vid, c.cue_no, c.light_id, c.time, c.target, c.duration, i)
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
  return vid;
}

// 经 HTTP 建出基线草稿（灯具甲/乙 + 两条回路 + 两条 Cue + 接线）并发布为版本 1
async function setupBase() {
  const base = {
    lights: [
      { id: 1, name: '甲' },
      { id: 2, name: '乙' },
    ],
    circuits: [
      { id: 1, name: '回路甲', capacity: 1500 },
      { id: 2, name: '回路乙', capacity: 1000 },
    ],
    cues: [
      { cue_no: 1, light_id: 1, time: 0, target: 50, duration: 0 },
      { cue_no: 2, light_id: 2, time: 2, target: 80, duration: 1 },
    ],
    wiring: [
      { light_id: 1, circuit_id: 1, watts: 300 },
      { light_id: 2, circuit_id: 2, watts: 200 },
    ],
  };
  for (const l of base.lights) {
    const r = await post('/api/lights', { name: l.name });
    assert.equal(r.status, 201);
    assert.equal(r.json.id, l.id);
  }
  for (const c of base.circuits) {
    const r = await post('/api/circuits', { name: c.name, capacity: c.capacity });
    assert.equal(r.status, 201);
    assert.equal(r.json.id, c.id);
  }
  for (const w of base.wiring) {
    const r = await put(`/api/lights/${w.light_id}/wiring`, w);
    assert.equal(r.status, 200);
  }
  const rq = await post('/api/cues', base.cues);
  assert.equal(rq.status, 201);
  const rv = await post('/api/versions', { label: '共同基线' });
  assert.equal(rv.status, 201);
  assert.equal(rv.json.id, 1);
  return base;
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

test('灯具交叉改名撞名：预览返回令牌/两侧取值/可读缘由，唯一组合一次事务落定', async () => {
  const base = await setupBase();
  // 草稿把灯具甲（#1）改名为「聚光」
  raw.prepare('UPDATE lights SET name = ? WHERE id = 1').run('聚光');
  // 待合入版本把灯具乙（#2）也改名为「聚光」
  const incoming = JSON.parse(JSON.stringify(base));
  incoming.lights[1].name = '聚光';
  const incomingId = insertVersion('B组改稿', incoming);

  // 1) 预览：200，两项冲突都带可读缘由与两侧取值，不再是 500
  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200, JSON.stringify(pv.json));
  assert.ok(pv.json.token, '预览必须返回一次性令牌');
  assert.equal(pv.json.summary.conflicts_total, 2);

  const c1 = pv.json.conflicts.find((c) => c.key === 'light:1');
  const c2 = pv.json.conflicts.find((c) => c.key === 'light:2');
  assert.ok(c1 && c2, '两盏交叉改名的灯具都必须列为冲突');
  for (const [c, draftName, incomingName] of [
    [c1, '聚光', '甲'],
    [c2, '乙', '聚光'],
  ]) {
    assert.equal(c.reason, 'name_collision');
    assert.ok(c.reason_text.includes('聚光'), c.reason_text);
    assert.ok(c.reason_text.includes('撞名'), c.reason_text);
    assert.ok(
      c.reasons.some((r) => r.code === 'name_collision' && r.side === null),
      '须带跨侧组合撞名缘由（side 为 null）'
    );
    // 两侧取值齐全，页面据此逐项选择
    assert.equal(c.draft.name, draftName);
    assert.equal(c.incoming.name, incomingName);
    assert.equal(c.attached, false, '规则类冲突没有可跟随的主体，须逐项显式抉择');
  }

  // 2) 撞名组合（各取改动侧）→ 400 整次拒绝，草稿不变，令牌仍可更正重试
  const dup = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:1': 'draft', 'light:2': 'incoming' },
  });
  assert.equal(dup.status, 400);
  assert.ok(dup.json.violations.some((v) => v.code === 'name_collision'));
  assert.ok(dup.json.violations.every((v) => typeof v.text === 'string' && v.text.length > 0));
  let lights = (await get('/api/lights')).json;
  assert.deepEqual(
    lights.map((l) => [l.id, l.name]),
    [
      [1, '聚光'],
      [2, '乙'],
    ],
    '拒绝后草稿必须保持原样'
  );

  // 3) 未完成抉择（只选一项）→ 400 明确报出未解决项，草稿不变
  const partial = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:1': 'draft' },
  });
  assert.equal(partial.status, 400);
  assert.deepEqual(partial.json.unresolved, ['light:2']);
  lights = (await get('/api/lights')).json;
  assert.equal(lights.find((l) => l.id === 2).name, '乙');

  // 4) 名称唯一的组合 → 200 一次事务落定：灯1 保留草稿改名、灯2 不采用待合入改名
  const cm = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:1': 'draft', 'light:2': 'draft' },
  });
  assert.equal(cm.status, 200, JSON.stringify(cm.json));
  assert.equal(cm.json.merged, true);
  const byId = Object.fromEntries(cm.json.draft.lights.map((l) => [l.id, l.name]));
  assert.deepEqual(byId, { 1: '聚光', 2: '乙' });
  // 接线/Cue 按编号关联，不随改名漂移
  const byIdFull = Object.fromEntries(cm.json.draft.lights.map((l) => [l.id, l]));
  assert.equal(byIdFull[1].circuit_id, 1);
  assert.equal(byIdFull[2].circuit_id, 2);
  assert.deepEqual(
    cm.json.draft.cues.map((c) => [c.cue_no, c.light_id]),
    [
      [1, 1],
      [2, 2],
    ]
  );

  // 5) 已发布版本快照不变（基线与待合入版本都保持原名称）
  const v1 = (await get('/api/versions/1')).json;
  assert.deepEqual(
    v1.lights.map((l) => [l.id, l.name]).sort(),
    [
      [1, '甲'],
      [2, '乙'],
    ]
  );

  // 6) 令牌一次性：成功提交后再用已作废
  const again = await post('/api/merge/commit', { token: pv.json.token, resolutions: {} });
  assert.equal(again.status, 404);
});

test('灯具交叉改名：对称的唯一组合（都采用待合入版本）同样一次事务落定', async () => {
  const base = await setupBase();
  raw.prepare('UPDATE lights SET name = ? WHERE id = 1').run('聚光');
  const incoming = JSON.parse(JSON.stringify(base));
  incoming.lights[1].name = '聚光';
  const incomingId = insertVersion('B组改稿', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200);

  // 灯1 采用待合入（放弃草稿改名，回到「甲」）、灯2 采用待合入（改名「聚光」）→ 唯一
  const cm = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:1': 'incoming', 'light:2': 'incoming' },
  });
  assert.equal(cm.status, 200, JSON.stringify(cm.json));
  const byId = Object.fromEntries(cm.json.draft.lights.map((l) => [l.id, l.name]));
  assert.deepEqual(byId, { 1: '甲', 2: '聚光' });
});

test('回路交叉改名撞名：同样列出可读缘由，唯一组合落定、撞名组合拒绝', async () => {
  const base = await setupBase();
  // 草稿把回路甲（#1）改名「主回路」
  const ren = await httpJson('PATCH', '/api/circuits/1', { name: '主回路' });
  assert.equal(ren.status, 200);
  // 待合入版本把回路乙（#2）也改名「主回路」
  const incoming = JSON.parse(JSON.stringify(base));
  incoming.circuits[1].name = '主回路';
  const incomingId = insertVersion('B组改回路', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200, JSON.stringify(pv.json));
  const c1 = pv.json.conflicts.find((c) => c.key === 'circuit:1');
  const c2 = pv.json.conflicts.find((c) => c.key === 'circuit:2');
  assert.ok(c1 && c2, '两条交叉改名的回路都必须列为冲突');
  for (const c of [c1, c2]) {
    assert.equal(c.reason, 'name_collision');
    assert.ok(c.reason_text.includes('主回路'), c.reason_text);
    assert.ok(c.reasons.some((r) => r.code === 'name_collision' && r.side === null));
  }

  // 撞名组合 → 400，草稿不变
  const dup = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'circuit:1': 'draft', 'circuit:2': 'incoming' },
  });
  assert.equal(dup.status, 400);
  assert.ok(dup.json.violations.some((v) => v.code === 'name_collision'));
  const circuits = (await get('/api/circuits')).json;
  assert.deepEqual(
    circuits.map((c) => [c.id, c.name]),
    [
      [1, '主回路'],
      [2, '回路乙'],
    ]
  );

  // 唯一组合 → 200；接线仍按回路编号关联
  const cm = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'circuit:1': 'draft', 'circuit:2': 'draft' },
  });
  assert.equal(cm.status, 200, JSON.stringify(cm.json));
  const names = Object.fromEntries(cm.json.draft.circuits.map((c) => [c.id, c.name]));
  assert.deepEqual(names, { 1: '主回路', 2: '回路乙' });
  const byLight = Object.fromEntries(cm.json.draft.lights.map((l) => [l.id, l.circuit_id]));
  assert.deepEqual(byLight, { 1: 1, 2: 2 });
});

test('交叉改名预览后草稿被改动 → 409 且令牌作废', async () => {
  const base = await setupBase();
  raw.prepare('UPDATE lights SET name = ? WHERE id = 1').run('聚光');
  const incoming = JSON.parse(JSON.stringify(base));
  incoming.lights[1].name = '聚光';
  const incomingId = insertVersion('B组改稿', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200);

  // 预览后草稿被编辑（新增一盏灯）
  const added = await post('/api/lights', { name: '预览后新改的灯' });
  assert.equal(added.status, 201);

  const cm = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:1': 'draft', 'light:2': 'draft' },
  });
  assert.equal(cm.status, 409);
  assert.ok(cm.json.error.includes('重新预览'));

  // 令牌随 409 作废：即使草稿恢复也不能再用
  await httpJson('DELETE', `/api/lights/${added.json.id}`);
  const again = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:1': 'draft', 'light:2': 'draft' },
  });
  assert.equal(again.status, 404);
});
