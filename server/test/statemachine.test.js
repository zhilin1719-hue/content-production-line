/* ============================================================
   statemachine.test.js — 状态机表驱动穷举校验
   选题 / 物料 / 场次 / 稿件 四张迁移表全部穷举
   ============================================================ */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const E = require('../engines');

function exhaustive(name, STATES, TRANSITIONS, can, transition) {
  const ALL_ACTIONS = ['discard', 'restore', 'publish', 'start', 'open', 'close',
    'reviewPass', 'reviewReject', 'finalPass', 'finalReject', 'revise', 'nonsense'];
  test(`${name}: 表驱动穷举(状态 × 动作)`, () => {
    for (const from of STATES) {
      const allowed = TRANSITIONS[from] || {};
      for (const action of ALL_ACTIONS) {
        const expectCan = !!allowed[action];
        assert.strictEqual(
          can(from, action), expectCan,
          `${name}: ${from} --${action}--> 期望 ${expectCan}`,
        );
        if (expectCan) {
          assert.strictEqual(transition(from, action), allowed[action], `${name}: ${from} --${action}--> ${allowed[action]}`);
        } else {
          assert.throws(() => transition(from, action), undefined, `${name}: ${from} --${action}--> 应抛错`);
        }
      }
    }
  });
  test(`${name}: 非法状态一律拒绝`, () => {
    for (const bad of ['', '不存在', null, undefined, 42]) {
      assert.strictEqual(can(bad, 'publish'), false);
      assert.throws(() => transition(bad, 'publish'));
    }
  });
}

/* ---------- 选题状态机 ---------- */
exhaustive('选题状态机', E.TOPIC_STATES, E.TOPIC_TRANSITIONS, E.canTopicTransition, E.transitionTopic);

test('选题状态机: 关键业务迁移语义', () => {
  assert.strictEqual(E.transitionTopic('选题', 'discard'), '已淘汰');
  assert.strictEqual(E.transitionTopic('已淘汰', 'restore'), '选题');
  assert.strictEqual(E.transitionTopic('选题', 'publish'), '已出稿');
  assert.strictEqual(E.canTopicTransition('已出稿', 'discard'), false, '已出稿不可淘汰');
  assert.strictEqual(E.canTopicTransition('已筛除', 'restore'), false, '已筛除不可恢复');
  assert.strictEqual(E.canTopicTransition('已淘汰', 'discard'), false, '重复淘汰拒绝');
});

/* ---------- 物料状态机 ---------- */
exhaustive('物料状态机', E.MATERIAL_STATES, E.MATERIAL_TRANSITIONS, E.canMaterialTransition, E.transitionMaterial);
test('物料状态机: 未发 → 已发 单向', () => {
  assert.strictEqual(E.transitionMaterial('未发', 'publish'), '已发');
  assert.strictEqual(E.canMaterialTransition('已发', 'publish'), false, '重复发布由幂等 409 拦截');
});

/* ---------- 场次状态机 ---------- */
exhaustive('场次状态机', E.SESSION_STATES, E.SESSION_TRANSITIONS, E.canSessionTransition, E.transitionSession);
test('场次状态机: 筹备→预热→正课→收官 主线', () => {
  let s = '筹备中';
  s = E.transitionSession(s, 'start'); assert.strictEqual(s, '预热中');
  s = E.transitionSession(s, 'open'); assert.strictEqual(s, '正课中');
  s = E.transitionSession(s, 'close'); assert.strictEqual(s, '已收官');
  assert.strictEqual(E.canSessionTransition('已收官', 'start'), false);
  assert.strictEqual(E.canSessionTransition('筹备中', 'close'), false, '不可跳级收官');
});

/* ---------- 稿件状态机 ---------- */
exhaustive('稿件状态机', E.DRAFT_STATES, E.DRAFT_TRANSITIONS, E.canDraftTransition, E.transitionDraft);
test('稿件状态机: 三层过审主线', () => {
  let d = '初稿';
  d = E.transitionDraft(d, 'reviewPass'); assert.strictEqual(d, '复核通过');
  d = E.transitionDraft(d, 'finalPass'); assert.strictEqual(d, '合规过审版');
  assert.strictEqual(E.canDraftTransition('合规过审版', 'revise'), false, '过审版锁定');
  assert.strictEqual(E.transitionDraft('复核通过', 'finalReject'), '打回');
  assert.strictEqual(E.transitionDraft('打回', 'revise'), '初稿');
  assert.strictEqual(E.canDraftTransition('初稿', 'finalPass'), false, '未过第二层不可直接终审');
});
