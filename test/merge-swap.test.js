'use strict';

// 三方合并提交的落库回归：名称互换、名称转交给本次删除的灯具/回路等
// 「最终结果唯一且引用有效、但逐行改名中途会撞上旧名」的场景，必须在
// 一次事务内提交成功；最终重名/引用缺失仍整次拒绝。
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Database = require('better-sqlite3');

// 独立临时库，不触碰开发数据
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-merge-swap-'));
process.env.DB_PATH = path.join(TMP_DIR, 'app.db');
const DB_PATH = process.env.DB_PATH;
const { app } = require('../server.js');

let server;
let port;
const raw = new Database(DB_PATH); // 直连：用于构造「另一组」已发布版本快照

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
const del = (p) => httpJson('DELETE', p);

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

// 经 HTTP 建出标准基线草稿并发布为版本 1，返回基线快照
async function setupBase() {
  const base = {
    lights: [
      { id: 1, name: '面光1' },
      { id: 2, name: '侧光L' },
    ],
    circuits: [
      { id: 1, name: '面光回路', capacity: 1500 },
      { id: 2, name: '侧光回路', capacity: 1000 },
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
    const body = w.circuit_id === null ? { circuit_id: null } : w;
    const r = await put(`/api/lights/${w.light_id}/wiring`, body);
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

test('两盏既有灯具互换名称：预览零冲突，凭令牌一次事务提交成功', async () => {
  const base = await setupBase();
  // 另一组的待合入版本：仅交换两盏灯的名称，其余不动
  const incoming = JSON.parse(JSON.stringify(base));
  incoming.lights[0].name = '侧光L';
  incoming.lights[1].name = '面光1';
  const incomingId = insertVersion('B组-换名', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200);
  assert.equal(pv.json.summary.conflicts_total, 0);
  assert.deepEqual(
    pv.json.auto
      .filter((e) => e.kind === 'light')
      .map((e) => `${e.key}:${e.action}`)
      .sort(),
    ['light:1:update', 'light:2:update']
  );

  const cm = await post('/api/merge/commit', { token: pv.json.token, resolutions: {} });
  assert.equal(cm.status, 200, JSON.stringify(cm.json));
  const byId = Object.fromEntries(cm.json.draft.lights.map((l) => [l.id, l]));
  assert.equal(byId[1].name, '侧光L');
  assert.equal(byId[2].name, '面光1');
  // 接线/Cue 按编号关联，不受改名影响
  assert.equal(byId[1].circuit_id, 1);
  assert.equal(byId[2].circuit_id, 2);
  assert.deepEqual(
    cm.json.draft.cues.map((c) => [c.cue_no, c.light_id]),
    [
      [1, 1],
      [2, 2],
    ]
  );

  // 已发布版本快照不变（基线仍是旧名）
  const v1 = (await get('/api/versions/1')).json;
  assert.deepEqual(
    v1.lights.map((l) => [l.id, l.name]).sort(),
    [
      [1, '面光1'],
      [2, '侧光L'],
    ]
  );

  // 令牌一次性：再用已作废
  const again = await post('/api/merge/commit', { token: pv.json.token, resolutions: {} });
  assert.equal(again.status, 404);
});

test('名称转交给本次删除的灯具（旧名持有者随本次合并删除）→ 自动合入成功', async () => {
  const base = await setupBase();
  // 待合入：删除灯 1（连同 cue1、接线），灯 2 改名为灯 1 的旧名「面光1」
  const incoming = {
    lights: [{ id: 2, name: '面光1' }],
    circuits: JSON.parse(JSON.stringify(base.circuits)), // 回路不动
    cues: base.cues.filter((c) => c.cue_no !== 1),
    wiring: [{ light_id: 2, circuit_id: 2, watts: 200 }],
  };

  const incomingId = insertVersion('B组-删灯转交名', incoming);
  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200);
  assert.equal(pv.json.summary.conflicts_total, 0, JSON.stringify(pv.json.conflicts));
  const keys = pv.json.auto.map((e) => `${e.kind}:${e.id}:${e.action}`).sort();
  assert.ok(keys.includes('light:1:delete'));
  assert.ok(keys.includes('light:2:update'));
  assert.ok(keys.includes('cue:1:delete'));

  const cm = await post('/api/merge/commit', { token: pv.json.token, resolutions: {} });
  assert.equal(cm.status, 200, JSON.stringify(cm.json));
  assert.deepEqual(cm.json.draft.lights.map((l) => [l.id, l.name]), [[2, '面光1']]);
  assert.deepEqual(cm.json.draft.cues.map((c) => c.cue_no), [2]);
});

test('两条回路互换名称（同类变更）→ 自动合入成功，接线按编号不变', async () => {
  const base = await setupBase();
  const incoming = JSON.parse(JSON.stringify(base));
  incoming.circuits[0].name = '侧光回路';
  incoming.circuits[1].name = '面光回路';
  const incomingId = insertVersion('B组-回路换名', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200);
  assert.equal(pv.json.summary.conflicts_total, 0);

  const cm = await post('/api/merge/commit', { token: pv.json.token, resolutions: {} });
  assert.equal(cm.status, 200, JSON.stringify(cm.json));
  const byId = Object.fromEntries(cm.json.draft.circuits.map((c) => [c.id, c.name]));
  assert.equal(byId[1], '侧光回路');
  assert.equal(byId[2], '面光回路');
  const lights = Object.fromEntries(cm.json.draft.lights.map((l) => [l.id, l.circuit_id]));
  assert.equal(lights[1], 1);
  assert.equal(lights[2], 2);
});

test('回路删除 + 留存回路接管旧名、接线同步改投 → 一次事务成功', async () => {
  const base = await setupBase();
  // 待合入：删回路 1；回路 2 改名「面光回路」；灯 1 接线改投回路 2
  const incoming = {
    lights: JSON.parse(JSON.stringify(base.lights)),
    circuits: [{ id: 2, name: '面光回路', capacity: 1000 }],
    cues: JSON.parse(JSON.stringify(base.cues)),
    wiring: [
      { light_id: 1, circuit_id: 2, watts: 300 },
      { light_id: 2, circuit_id: 2, watts: 200 },
    ],
  };
  const incomingId = insertVersion('B组-并回路', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200);
  assert.equal(pv.json.summary.conflicts_total, 0, JSON.stringify(pv.json.conflicts));

  const cm = await post('/api/merge/commit', { token: pv.json.token, resolutions: {} });
  assert.equal(cm.status, 200, JSON.stringify(cm.json));
  assert.deepEqual(cm.json.draft.circuits.map((c) => [c.id, c.name]), [[2, '面光回路']]);
  const byId = Object.fromEntries(cm.json.draft.lights.map((l) => [l.id, l]));
  assert.equal(byId[1].circuit_id, 2);
  assert.equal(byId[1].watts, 300);
  assert.equal(byId[2].circuit_id, 2);
});

test('最终仍重名：抉择导致两灯同名 → 400 整次拒绝，令牌仍可更正后重试', async () => {
  await setupBase();
  // 待合入单侧新增灯 3，名称与灯 1 相同 → 预览判为冲突
  const incoming = JSON.parse(JSON.stringify(await loadBaseSnap()));
  incoming.lights.push({ id: 3, name: '面光1' });
  incoming.wiring.push({ light_id: 3, circuit_id: null, watts: null });
  const incomingId = insertVersion('B组-重名新灯', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200);
  assert.ok(pv.json.conflicts.some((c) => c.key === 'light:3'));

  // 选「采用待合入」引入灯 3 → 与灯 1 最终重名，整次拒绝，不写入
  const bad = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:3': 'incoming' },
  });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.violations.some((v) => v.code === 'name_collision'));
  const lightsAfterBad = (await get('/api/lights')).json;
  assert.equal(lightsAfterBad.some((l) => l.id === 3), false);

  // 令牌未因 400 作废：改选「保留草稿」（不引入灯 3）→ 提交成功
  const ok = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:3': 'draft' },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.draft.lights.some((l) => l.id === 3), false);
});

test('Cue 引用缺失灯具的抉择组合 → 400 整次拒绝且草稿不变', async () => {
  await setupBase();
  // 待合入删除灯 1、却保留并修改 cue1（快照内部不自洽，由冲突抉择决定结果）
  const incoming = JSON.parse(JSON.stringify(await loadBaseSnap()));
  incoming.lights = incoming.lights.filter((l) => l.id !== 1);
  incoming.wiring = incoming.wiring.filter((w) => w.light_id !== 1);
  incoming.cues = incoming.cues.map((c) =>
    c.cue_no === 1 ? { ...c, target: 90 } : c
  );
  const incomingId = insertVersion('B组-悬空Cue', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200);
  assert.ok(pv.json.conflicts.some((c) => c.key.startsWith('light:1')));
  assert.ok(pv.json.conflicts.some((c) => c.key === 'cue:1'));

  // cue1 采用待合入（保留）、灯 1 也采用待合入（删除）→ 引用缺失
  const bad = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:1': 'incoming', 'cue:1': 'incoming' },
  });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.violations.some((v) => v.code === 'reference_missing'));
  const lights = (await get('/api/lights')).json;
  assert.ok(lights.some((l) => l.id === 1)); // 草稿原样
  const cue1 = (await get('/api/cues')).json.find((c) => c.cue_no === 1);
  assert.equal(cue1.target, 50);
});

test('预览后草稿被改动 → 409 且令牌作废', async () => {
  const base = await setupBase();
  const incoming = JSON.parse(JSON.stringify(base));
  incoming.lights[0].name = '侧光L';
  incoming.lights[1].name = '面光1';
  const incomingId = insertVersion('B组-换名', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200);

  const added = await post('/api/lights', { name: '预览后新改的灯' });
  assert.equal(added.status, 201);

  const cm = await post('/api/merge/commit', { token: pv.json.token, resolutions: {} });
  assert.equal(cm.status, 409);

  // 令牌随 409 作废：即使草稿恢复也不能再用
  await del(`/api/lights/${added.json.id}`);
  const again = await post('/api/merge/commit', { token: pv.json.token, resolutions: {} });
  assert.equal(again.status, 404);
});

test('合入成功后绑定已发布版本的调光记录仍在', async () => {
  const base = await setupBase();
  const rec = await post('/api/records', { version_id: 1, label: '合入前的调光记录' });
  assert.equal(rec.status, 201);

  const incoming = JSON.parse(JSON.stringify(base));
  incoming.lights[0].name = '侧光L';
  incoming.lights[1].name = '面光1';
  const incomingId = insertVersion('B组-换名', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  const cm = await post('/api/merge/commit', { token: pv.json.token, resolutions: {} });
  assert.equal(cm.status, 200, JSON.stringify(cm.json));

  const records = (await get('/api/records')).json;
  assert.ok(Array.isArray(records) ? records.some((r) => r.id === rec.json.id) : records.id === rec.json.id);
});

// setupBase 经 HTTP 建好的基线即当前草稿；直接读库重组一份等价快照
async function loadBaseSnap() {
  const lights = (await get('/api/lights')).json.map((l) => ({ id: l.id, name: l.name }));
  const circuits = (await get('/api/circuits')).json.map((c) => ({
    id: c.id,
    name: c.name,
    capacity: c.capacity,
  }));
  const cues = (await get('/api/cues')).json.map((c) => ({
    cue_no: c.cue_no,
    light_id: c.light_id,
    time: c.time,
    target: c.target,
    duration: c.duration,
  }));
  const lightsRaw = raw.prepare('SELECT id, circuit_id, watts FROM lights ORDER BY id').all();
  const wiring = lightsRaw.map((l) => ({
    light_id: l.id,
    circuit_id: l.circuit_id ?? null,
    watts: l.watts ?? null,
  }));
  return { lights, circuits, cues, wiring };
}
