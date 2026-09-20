import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES, sample } from '../fixtures/examples';
import { decide, POLICY } from '../src/policy';
import { parseClassification } from '../src/taxonomy';

test('representative workflows produce expected observe-only proposals', () => {
  assert.deepEqual(EXAMPLES.map(e => decide(e.classification).disposition), ['now', 'action', 'action', 'fyi', 'archive_candidate', 'security_review', 'manual_review']);
  for (const e of EXAMPLES) {
    const p = decide(e.classification);
    assert.equal(p.mailboxWrites, 0);
    assert.equal(p.keepInInbox, true);
  }
});
test('security review overrides archive and incomplete content', () => {
  const c = sample('none', 'newsletter_marketing', 'archive', 0.01, POLICY.securityReview);
  assert.deepEqual(decide(c, ['Attachments missing']).proposedCategories, ['JEV-SECURITY-REVIEW']);
});
test('uncertain security and missing content produce no ordinary categories', () => {
  assert.deepEqual(decide(sample('none', 'automated', 'archive', 0, 0.2)).proposedCategories, []);
  assert.equal(decide(sample('soon', 'internal_maintenance', 'order_buy', 0.99), ['Attachments not analyzed']).disposition, 'manual_review');
});
test('confidence and winning probability are evaluated separately', () => {
  const c = { ...sample('soon', 'supply_chain', 'reply', 0.99) };
  c.type = { ...c.type, confidence: 0.79 };
  assert.equal(decide(c).disposition, 'manual_review');
  c.type = { ...c.type, confidence: 0.99 };
  const keys = Object.keys(c.type.probabilities) as Array<keyof typeof c.type.probabilities>;
  c.type = { ...c.type, probabilities: Object.fromEntries(keys.map(key => [key, key === 'supply_chain' ? 0.79 : 0.21 / 9])) as typeof c.type.probabilities };
  assert.equal(decide(c).disposition, 'manual_review');
});
test('conflicting independently generated answers are held for review', () => {
  assert.equal(decide(sample('none', 'automated', 'archive', 0.99)).disposition, 'manual_review');
  assert.equal(decide(sample('soon', 'supply_chain', 'reply', 0.01)).disposition, 'manual_review');
  assert.equal(decide(sample('now', 'customer_sales', 'reply', 0.75)).disposition, 'manual_review');
});
test('archive candidacy requires stricter probability, confidence and risk gates', () => {
  const c = { ...sample('none', 'newsletter_marketing', 'archive', 0.01) };
  c.action = { ...c.action, confidence: 0.94 };
  assert.equal(decide(c).disposition, 'none');
  assert.equal(decide(sample('none', 'newsletter_marketing', 'archive', 0.01, 0.06)).disposition, 'none');
});
test('invalid, partial or inconsistent model responses fail closed', () => {
  const base = sample('none', 'automated', 'archive', 0.01);
  const bad = [null, {}, { ...base, needs_owner: { type: 'noul', noul: NaN } }, { ...base, security_risk: { type: 'noul', noul: 2 } }, { ...base, attention: { ...base.attention, probabilities: { none: 1 } } }, { ...base, attention: { ...base.attention, choice: 'now' } }];
  for (const c of bad) {
    assert.throws(() => parseClassification(c));
    assert.equal(decide(c).disposition, 'manual_review');
    assert.deepEqual(decide(c).proposedCategories, []);
  }
});
