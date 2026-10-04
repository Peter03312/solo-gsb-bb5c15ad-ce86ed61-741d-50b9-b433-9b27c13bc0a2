'use strict';

// 同编号新增主体（灯具/回路）的三方合并依附关系：
// 两组从同一基线各自新增了相同编号的灯具/回路，待合入侧引用该编号的新增 Cue /
// 改投接线不得再当作自动项；它们必须显示与冲突主体的关系，跟随主体同侧落定，
// 依附项自身另有冲突时逐项抉择；不一致的选择 / 最终重名 / 引用缺失整次拒绝；
// 无依附冲突的单侧改动仍自动合入。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Merge = require('../src/merge.js');

function baseSnapshot(overrides = {}) {
  return {
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
    ...overrides,
  };
}

const clone = (s) => JSON.parse(JSON.stringify(s));
const findC = (r, key) => r.conflicts.find((c) => c.key === key) || null;

function sidesAddLight9() {
  const base = baseSnapshot();
  const draft = clone(base);
  draft.lights.push({ id: 9, name: '草稿新灯' });
  draft.wiring.push({ light_id: 9, circuit_id: null, watts: null });
  const incoming = clone(base);
  incoming.lights.push({ id: 9, name: '合入新灯' });
  incoming.wiring.push({ light_id: 9, circuit_id: null, watts: null });
  return { base, draft, incoming };
}

test('同编号新增灯具：待合入侧引用该编号的新增 Cue 不得列为自动项', () => {
  const { base, draft, incoming } = sidesAddLight9();
  // 草稿为灯 9 加了 Cue 3；待合入为灯 9 加了 Cue 3（同编号异值）和 Cue 4（单侧新增）
  draft.cues.push({ cue_no: 3, light_id: 9, time: 1, target: 10, duration: 0 });
  incoming.cues.push({ cue_no: 3, light_id: 9, time: 2, target: 20, duration: 0 });
  incoming.cues.push({ cue_no: 4, light_id: 9, time: 3, target: 30, duration: 0 });

  const cls = Merge.classify(base, draft, incoming);
  assert.equal(findC(cls, 'light:9')?.reason, 'same_key_diff');
  // cue:3 自身同编号异值，仍为结构性冲突（逐项抉择）
  assert.equal(findC(cls, 'cue:3')?.reason, 'same_key_diff');
  assert.equal(findC(cls, 'cue:3')?.attached, false);
  // cue:4 是纯依附项：从 auto 降级为冲突
  const c4 = findC(cls, 'cue:4');
  assert.ok(c4, '依附新增 Cue 必须出现在冲突列表');
  assert.equal(c4.attached, true);
  assert.equal(c4.reason, 'attached_to_conflict');
  assert.ok(c4.reasons.some((r) => r.code === 'attached_to_conflict'));
  assert.ok(c4.edges.some((e) => e.side === 'incoming' && e.host_key === 'light:9'));
  assert.equal(cls.auto.some((a) => a.key === 'cue:4'), false);
});

test('保留草稿主体时：依附的待合入 Cue/接线不得误合入', () => {
  const { base, draft, incoming } = sidesAddLight9();
  incoming.cues.push({ cue_no: 4, light_id: 9, time: 3, target: 30, duration: 0 });
  incoming.wiring = incoming.wiring.map((w) =>
    w.light_id === 9 ? { light_id: 9, circuit_id: 1, watts: 200 } : w
  );
  draft.wiring = draft.wiring.map((w) =>
    w.light_id === 9 ? { light_id: 9, circuit_id: null, watts: null } : w
  );

  // 只显式选择主体（草稿）与本身有结构性冲突的接线；cue:4 跟随主体
  const r = Merge.resolve(base, draft, incoming, { 'light:9': 'draft', 'wiring:9': 'draft' });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  // 待合入的 cue:4 未进入草稿，不会挂到草稿灯 9
  assert.equal(r.final.cues.some((c) => c.cue_no === 4), false);
  // 草稿灯 9 的接线保持草稿侧（未分配），未采用待合入侧接线
  assert.deepEqual(r.final.wiring.find((w) => w.light_id === 9), {
    light_id: 9,
    circuit_id: null,
    watts: null,
  });
});

test('采用待合入主体时：依附的待合入 Cue/接线正确合入', () => {
  const { base, draft, incoming } = sidesAddLight9();
  incoming.cues.push({ cue_no: 4, light_id: 9, time: 3, target: 30, duration: 0 });
  incoming.wiring = incoming.wiring.map((w) =>
    w.light_id === 9 ? { light_id: 9, circuit_id: 1, watts: 200 } : w
  );

  const r = Merge.resolve(base, draft, incoming, { 'light:9': 'incoming', 'wiring:9': 'incoming' });
  assert.equal(r.ok, true);
  const c4 = r.final.cues.find((c) => c.cue_no === 4);
  assert.ok(c4);
  assert.equal(c4.light_id, 9);
  assert.equal(c4.target, 30);
  assert.deepEqual(r.final.wiring.find((w) => w.light_id === 9), {
    light_id: 9,
    circuit_id: 1,
    watts: 200,
  });
});

test('依附项本身另有结构性冲突 → 逐项抉择；选择同侧合法', () => {
  const { base, draft, incoming } = sidesAddLight9();
  draft.cues.push({ cue_no: 3, light_id: 9, time: 1, target: 10, duration: 0 });
  incoming.cues.push({ cue_no: 3, light_id: 9, time: 2, target: 20, duration: 0 });

  // cue:3 自身同编号异值，不跟随、必须显式选
  const noChoice = Merge.resolve(base, draft, incoming, { 'light:9': 'draft' });
  assert.equal(noChoice.ok, false);
  assert.ok(noChoice.unresolved.includes('cue:3'));

  const bothDraft = Merge.resolve(base, draft, incoming, {
    'light:9': 'draft',
    'cue:3': 'draft',
  });
  assert.equal(bothDraft.ok, true);
  assert.equal(bothDraft.final.cues.find((c) => c.cue_no === 3).target, 10);

  const bothIncoming = Merge.resolve(base, draft, incoming, {
    'light:9': 'incoming',
    'cue:3': 'incoming',
  });
  assert.equal(bothIncoming.ok, true);
  assert.equal(bothIncoming.final.cues.find((c) => c.cue_no === 3).target, 20);
});

test('依附项与主体选择不同侧 → 整次拒绝（不产生最终结果）', () => {
  const { base, draft, incoming } = sidesAddLight9();
  incoming.cues.push({ cue_no: 4, light_id: 9, time: 3, target: 30, duration: 0 });

  const r = Merge.resolve(base, draft, incoming, {
    'light:9': 'draft',
    'cue:4': 'incoming', // 纯依附项显式选另一侧
  });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.key === 'cue:4' && v.code === 'inconsistent_choice'));

  // 结构性冲突依附项同样校验
  draft.cues.push({ cue_no: 3, light_id: 9, time: 1, target: 10, duration: 0 });
  incoming.cues.push({ cue_no: 3, light_id: 9, time: 2, target: 20, duration: 0 });
  const r2 = Merge.resolve(base, draft, incoming, {
    'light:9': 'draft',
    'cue:3': 'incoming',
  });
  assert.equal(r2.ok, false);
  assert.ok(r2.violations.some((v) => v.key === 'cue:3' && v.code === 'inconsistent_choice'));
});

test('草稿侧对称依附：草稿新增 Cue 引用草稿的同编号新灯，采用待合入主体时不漂移', () => {
  const { base, draft, incoming } = sidesAddLight9();
  draft.cues.push({ cue_no: 3, light_id: 9, time: 1, target: 10, duration: 0 });

  const cls = Merge.classify(base, draft, incoming);
  const c3 = findC(cls, 'cue:3');
  assert.ok(c3);
  assert.equal(c3.attached, true);
  assert.ok(c3.edges.some((e) => e.side === 'draft' && e.host_key === 'light:9'));

  // 采用待合入灯 9：草稿的 cue:3 跟随删除，不挂到待合入灯 9
  const ri = Merge.resolve(base, draft, incoming, { 'light:9': 'incoming' });
  assert.equal(ri.ok, true);
  assert.equal(ri.final.cues.some((c) => c.cue_no === 3), false);

  // 保留草稿灯 9：cue:3 保留
  const rd = Merge.resolve(base, draft, incoming, { 'light:9': 'draft' });
  assert.equal(rd.ok, true);
  assert.equal(rd.final.cues.find((c) => c.cue_no === 3).target, 10);

  // 显式跨侧 → 拒绝
  const rx = Merge.resolve(base, draft, incoming, { 'light:9': 'incoming', 'cue:3': 'draft' });
  assert.equal(rx.ok, false);
  assert.ok(rx.violations.some((v) => v.code === 'inconsistent_choice'));
});

test('同编号新增回路 + 既有灯具接线改投：跟随两侧都正确，跨侧拒绝', () => {
  const base = baseSnapshot();
  const draft = clone(base);
  draft.circuits.push({ id: 9, name: '草稿回路9', capacity: 500 });
  const incoming = clone(base);
  incoming.circuits.push({ id: 9, name: '合入回路9', capacity: 800 });
  incoming.wiring = incoming.wiring.map((w) =>
    w.light_id === 1 ? { light_id: 1, circuit_id: 9, watts: 333 } : w
  );

  const cls = Merge.classify(base, draft, incoming);
  assert.equal(findC(cls, 'circuit:9')?.reason, 'same_key_diff');
  const w1 = findC(cls, 'wiring:1');
  assert.ok(w1);
  assert.equal(w1.attached, true);
  assert.ok(w1.edges.some((e) => e.side === 'incoming' && e.host_key === 'circuit:9'));

  const rd = Merge.resolve(base, draft, incoming, { 'circuit:9': 'draft' });
  assert.equal(rd.ok, true);
  assert.deepEqual(
    rd.final.wiring.find((w) => w.light_id === 1),
    { light_id: 1, circuit_id: 1, watts: 300 } // 保持草稿侧（基线）接线
  );

  const ri = Merge.resolve(base, draft, incoming, { 'circuit:9': 'incoming' });
  assert.equal(ri.ok, true);
  assert.deepEqual(
    ri.final.wiring.find((w) => w.light_id === 1),
    { light_id: 1, circuit_id: 9, watts: 333 }
  );
  assert.equal(ri.final.circuits.find((c) => c.id === 9).capacity, 800);

  const rx = Merge.resolve(base, draft, incoming, {
    'circuit:9': 'draft',
    'wiring:1': 'incoming',
  });
  assert.equal(rx.ok, false);
  assert.ok(rx.violations.some((v) => v.code === 'inconsistent_choice'));
});

test('依附项两侧取值相同（都未分配）→ 不需额外抉择，两种主体选择都自洽', () => {
  const { base, draft, incoming } = sidesAddLight9(); // 两侧灯9接线均为未分配
  const cls = Merge.classify(base, draft, incoming);
  assert.equal(findC(cls, 'wiring:9'), null); // 等价内容不降级
  const rd = Merge.resolve(base, draft, incoming, { 'light:9': 'draft' });
  assert.equal(rd.ok, true);
  const ri = Merge.resolve(base, draft, incoming, { 'light:9': 'incoming' });
  assert.equal(ri.ok, true);
});

test('无依附冲突的单侧新增仍自动合入', () => {
  const base = baseSnapshot();
  const draft = clone(base);
  const incoming = clone(base);
  incoming.lights.push({ id: 7, name: '对方独有灯' });
  incoming.wiring.push({ light_id: 7, circuit_id: null, watts: null });
  incoming.cues.push({ cue_no: 9, light_id: 7, time: 5, target: 60, duration: 0 });

  const cls = Merge.classify(base, draft, incoming);
  assert.equal(cls.conflicts.length, 0);
  assert.deepEqual(
    cls.auto.map((a) => a.key).sort(),
    ['cue:9', 'light:7', 'wiring:7']
  );
  const r = Merge.resolve(base, draft, incoming, {});
  assert.equal(r.ok, true);
  assert.ok(r.final.lights.some((l) => l.id === 7));
  assert.ok(r.final.cues.some((c) => c.cue_no === 9));
});

test('抉择后最终重名：依附冲突之外的规则冲突仍整次拒绝', () => {
  // 待合入单侧新增灯 7，名称与灯 1 相同（既有规则类冲突路径保持不变）
  const base = baseSnapshot();
  const draft = clone(base);
  const incoming = clone(base);
  incoming.lights.push({ id: 7, name: '面光1' });
  incoming.wiring.push({ light_id: 7, circuit_id: null, watts: null });

  const r = Merge.resolve(base, draft, incoming, { 'light:7': 'incoming', 'light:1': 'incoming' });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.code === 'name_collision'));
});
