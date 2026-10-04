'use strict';

// 同编号新增灯具/回路的合并 HTTP 回归：
// 预览须把待合入侧引用同编号的新增 Cue/接线列为依附冲突（而非 auto），呈现与主体的
// 关系及各侧选择结果；保留草稿主体时不得误合入，采用待合入主体时正确合入；不一致
// 选择 / 最终引用缺失整次拒绝且草稿不变；预览后草稿变化 409；已发布版本与调光记录不变。
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Database = require('better-sqlite3');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-merge-attach-'));
process.env.DB_PATH = path.join(TMP_DIR, 'app.db');
const DB_PATH = process.env.DB_PATH;
const { app } = require('../server.js');

let server;
let port;
const raw = new Database(DB_PATH);

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

// 经 HTTP 建出标准基线草稿并发布为版本 1
async function setupBase() {
  const base = {
    lights: [
      { id: 1, name: '面光1' },
      { id: 2, name: '侧光L' },
    ],
    circuits: [{ id: 1, name: '面光回路', capacity: 1500 }],
    cues: [
      { cue_no: 1, light_id: 1, time: 0, target: 50, duration: 0 },
      { cue_no: 2, light_id: 2, time: 2, target: 80, duration: 1 },
    ],
    wiring: [
      { light_id: 1, circuit_id: 1, watts: 300 },
      { light_id: 2, circuit_id: null, watts: null },
    ],
  };
  for (const l of base.lights) {
    const r = await post('/api/lights', { name: l.name });
    assert.equal(r.status, 201);
  }
  for (const c of base.circuits) {
    const r = await post('/api/circuits', { name: c.name, capacity: c.capacity });
    assert.equal(r.status, 201);
  }
  for (const w of base.wiring) {
    await put(`/api/lights/${w.light_id}/wiring`, w.circuit_id === null ? { circuit_id: null } : w);
  }
  await post('/api/cues', base.cues);
  await post('/api/versions', { label: '共同基线' });
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
beforeEach(() => hardReset());

test('同编号新增灯具：依附 Cue 在预览中呈现关系与各侧结果，保留草稿不误合入', async () => {
  const base = await setupBase();

  // 草稿侧新增灯 3 + cue 3
  const draftExtra = { light: { name: '草稿新增灯3' } };
  const dl = await post('/api/lights', { name: draftExtra.light.name });
  assert.equal(dl.status, 201);
  assert.equal(dl.json.id, 3);
  const dc = await post('/api/cues', { light_id: 3, time: 1, target: 11, duration: 0 });
  assert.equal(dc.status, 201);
  assert.equal(dc.json.find((c) => c.light_id === 3).cue_no, 3);

  // 待合入版本：同编号灯 3（不同名）+ cue 3（异值）+ cue 4（单侧新增引用灯3）
  const incoming = JSON.parse(JSON.stringify(base));
  incoming.lights.push({ id: 3, name: '待合入灯3' });
  incoming.wiring.push({ light_id: 3, circuit_id: null, watts: null });
  incoming.cues.push({ cue_no: 3, light_id: 3, time: 2, target: 22, duration: 0 });
  incoming.cues.push({ cue_no: 4, light_id: 3, time: 3, target: 44, duration: 0 });
  const incomingId = insertVersion('B组-同编号新灯', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200);

  const keys = pv.json.conflicts.map((c) => c.key).sort();
  assert.deepEqual(keys, ['cue:3', 'cue:4', 'light:3']);
  // cue:4 不得出现在 auto
  assert.equal(pv.json.auto.some((a) => a.key === 'cue:4'), false);

  const c4 = pv.json.conflicts.find((c) => c.key === 'cue:4');
  assert.equal(c4.attached, true);
  assert.equal(c4.status, 'incoming_added');
  assert.ok(/灯具 #3/.test(c4.reason_text), c4.reason_text);
  // 依附关系结构化呈现：待合入侧绑定 light:3；草稿侧该 Cue 不存在
  assert.deepEqual(
    c4.attachments.incoming.map((a) => a.host_key),
    ['light:3']
  );
  assert.equal(c4.attachments.draft.length, 0);
  assert.equal(c4.incoming.light_id, 3);
  assert.equal(c4.draft, null);
  assert.ok(c4.binding_note.incoming.includes('同进同退'));

  // cue:3 本身同编号异值：结构性冲突，不是依附项
  const c3 = pv.json.conflicts.find((c) => c.key === 'cue:3');
  assert.equal(c3.attached, false);
  assert.equal(c3.reason, 'same_key_diff');

  // 提交：灯3、cue3 选草稿（两侧灯3接线均为未分配、等价无需选择），cue4 跟随 → 不引入
  const cm = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:3': 'draft', 'cue:3': 'draft' },
  });
  assert.equal(cm.status, 200, JSON.stringify(cm.json));
  const lights = (await get('/api/lights')).json;
  const l3 = lights.find((l) => l.id === 3);
  assert.equal(l3.name, '草稿新增灯3');
  const cues = (await get('/api/cues')).json;
  assert.equal(cues.some((c) => c.cue_no === 4), false);
  assert.equal(cues.find((c) => c.cue_no === 3).target, 11);
});

test('采用待合入主体：依附 Cue 随主体正确合入', async () => {
  const base = await setupBase();
  // 草稿也加灯3（与待合入同编号异名）
  const dl = await post('/api/lights', { name: '草稿新增灯3' });
  assert.equal(dl.json.id, 3);

  const incoming = JSON.parse(JSON.stringify(base));
  incoming.lights.push({ id: 3, name: '待合入灯3' });
  incoming.wiring.push({ light_id: 3, circuit_id: 1, watts: 250 });
  incoming.cues.push({ cue_no: 4, light_id: 3, time: 3, target: 44, duration: 0 });
  const incomingId = insertVersion('B组-同编号新灯2', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200);
  assert.ok(pv.json.conflicts.some((c) => c.key === 'cue:4' && c.attached));
  // wiring:3 两侧新增异值（未分配 vs 接回路1），本身是结构性冲突须逐项抉择
  const w3 = pv.json.conflicts.find((c) => c.key === 'wiring:3');
  assert.ok(w3);
  assert.equal(w3.attached, false);
  assert.equal(w3.reason, 'same_key_diff');

  // 只选主体、不选 wiring:3 → 未解决冲突
  const incomplete = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:3': 'incoming' },
  });
  assert.equal(incomplete.status, 400);
  assert.deepEqual(incomplete.json.unresolved, ['wiring:3']);

  const cm = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:3': 'incoming', 'wiring:3': 'incoming' },
  });
  assert.equal(cm.status, 200, JSON.stringify(cm.json));
  const lights = (await get('/api/lights')).json;
  assert.equal(lights.find((l) => l.id === 3).name, '待合入灯3');
  assert.deepEqual(
    lights.find((l) => l.id === 3).circuit_id,
    1
  );
  const cues = (await get('/api/cues')).json;
  const c4 = cues.find((c) => c.cue_no === 4);
  assert.ok(c4);
  assert.equal(c4.light_id, 3);
  assert.equal(c4.target, 44);
});

test('不一致的选择（保留草稿主体却合入待合入依附 Cue）→ 400 整次拒绝、草稿不变', async () => {
  await setupBase();
  const dl = await post('/api/lights', { name: '草稿新增灯3' });
  assert.equal(dl.json.id, 3);

  const baseSnap = {
    lights: (await get('/api/lights')).json.map((l) => ({ id: l.id, name: l.name })),
    circuits: [{ id: 1, name: '面光回路', capacity: 1500 }],
    cues: [],
    wiring: [
      { light_id: 1, circuit_id: 1, watts: 300 },
      { light_id: 2, circuit_id: null, watts: null },
      { light_id: 3, circuit_id: null, watts: null },
    ],
  };
  const incoming = JSON.parse(JSON.stringify(baseSnap));
  // 还原基线 cues（灯1/灯2两条）
  incoming.cues = [
    { cue_no: 1, light_id: 1, time: 0, target: 50, duration: 0 },
    { cue_no: 2, light_id: 2, time: 2, target: 80, duration: 1 },
  ];
  incoming.lights = incoming.lights.map((l) => (l.id === 3 ? { id: 3, name: '待合入灯3' } : l));
  incoming.cues.push({ cue_no: 4, light_id: 3, time: 3, target: 44, duration: 0 });
  const incomingId = insertVersion('B组-依附错配', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200);

  const before = await get('/api/lights');
  const beforeCues = await get('/api/cues');

  const bad = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:3': 'draft', 'cue:4': 'incoming' },
  });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.violations.some((v) => v.code === 'inconsistent_choice'));
  assert.ok(/同一侧/.test(bad.json.error), bad.json.error);

  const after = await get('/api/lights');
  const afterCues = await get('/api/cues');
  assert.deepEqual(after.json, before.json);
  assert.deepEqual(afterCues.json, beforeCues.json);

  // 令牌仍可更正为跟随/同侧后成功
  const ok = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:3': 'draft' },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal((await get('/api/cues')).json.some((c) => c.cue_no === 4), false);
});

test('预览后草稿变化 → 409 且令牌作废（依附冲突场景同样适用）', async () => {
  const base = await setupBase();
  const dl = await post('/api/lights', { name: '草稿新增灯3' });
  assert.equal(dl.json.id, 3);

  const incoming = JSON.parse(JSON.stringify(base));
  incoming.lights.push({ id: 3, name: '待合入灯3' });
  incoming.wiring.push({ light_id: 3, circuit_id: null, watts: null });
  incoming.cues.push({ cue_no: 4, light_id: 3, time: 3, target: 44, duration: 0 });
  const incomingId = insertVersion('B组-依附409', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  assert.equal(pv.status, 200);

  const added = await post('/api/lights', { name: '预览后又加的灯' });
  assert.equal(added.status, 201);

  const cm = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:3': 'incoming' },
  });
  assert.equal(cm.status, 409);

  const again = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:3': 'incoming' },
  });
  assert.equal(again.status, 404);
});

test('合入成功后已发布版本与调光记录均不变', async () => {
  const base = await setupBase();
  const rec = await post('/api/records', { version_id: 1, label: '依附测试前的记录' });
  assert.equal(rec.status, 201);

  const dl = await post('/api/lights', { name: '草稿新增灯3' });
  assert.equal(dl.json.id, 3);

  const incoming = JSON.parse(JSON.stringify(base));
  incoming.lights.push({ id: 3, name: '待合入灯3' });
  incoming.wiring.push({ light_id: 3, circuit_id: null, watts: null });
  const incomingId = insertVersion('B组-依附记录', incoming);

  const pv = await post('/api/merge/preview', {
    base_version_id: 1,
    incoming_version_id: incomingId,
  });
  const cm = await post('/api/merge/commit', {
    token: pv.json.token,
    resolutions: { 'light:3': 'incoming' },
  });
  assert.equal(cm.status, 200, JSON.stringify(cm.json));

  // 基线版本快照不变
  const v1 = (await get('/api/versions/1')).json;
  assert.deepEqual(
    v1.lights.map((l) => l.id).sort(),
    [1, 2]
  );
  // 调光记录仍在
  const records = (await get('/api/records')).json;
  assert.ok(records.some((r) => r.id === rec.json.id));
  const r1 = (await get(`/api/records/${rec.json.id}`)).json;
  assert.equal(r1.version.id, 1);
});
