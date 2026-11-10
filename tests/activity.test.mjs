import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityPolicy } from '../src/activity.ts';

class Page extends EventTarget {
  hidden = false;
  focused = true;
  documentElement = { dataset: {} };
  hasFocus() {
    return this.focused;
  }
}

test('background rendering follows visibility/focus events and stops listening on disposal', () => {
  const page = new Page();
  const view = new EventTarget();
  const changes = [];
  const policy = createActivityPolicy(
    (active) => changes.push(active),
    page,
    view,
  );
  assert.equal(policy.active, true);
  page.hidden = true;
  page.dispatchEvent(new Event('visibilitychange'));
  view.dispatchEvent(new Event('blur'));
  assert.deepEqual(changes, [false]);
  page.hidden = false;
  view.dispatchEvent(new Event('focus'));
  assert.deepEqual(changes, [false, true]);
  policy.dispose();
  page.hidden = true;
  page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(policy.active, true);
});

test('native window state overrides stale WebView2 focus without polling', () => {
  const page = new Page();
  const view = new EventTarget();
  const policy = createActivityPolicy(() => {}, page, view);
  view.dispatchEvent(
    new CustomEvent('tiny-native-activity', { detail: { active: false } }),
  );
  assert.equal(policy.active, false);
  assert.equal(page.documentElement.dataset.activity, 'background');
  view.dispatchEvent(new Event('focus'));
  assert.equal(policy.active, false);
  view.dispatchEvent(
    new CustomEvent('tiny-native-activity', { detail: { active: true } }),
  );
  assert.equal(policy.active, true);
  policy.dispose();
});
