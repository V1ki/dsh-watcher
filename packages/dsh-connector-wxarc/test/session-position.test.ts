import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionPoint } from '../src/session-position.js';
import type { DesktopLayout, Rect } from '../src/session-position.js';

const win: Rect = { x: 500, y: 80, width: 760, height: 620 };
const row: Rect = { x: 530, y: 170, width: 230, height: 52 };
const screen: Rect = { x: 0, y: 25, width: 1600, height: 850 };
const layout = (covers: Rect[]): DesktopLayout => ({ bounds: win, usable: [screen], covers });

test('covered centre uses exposed portion of the same row', () => {
  const result = sessionPoint(row, win, layout([{ x: 625, y: 130, width: 300, height: 290 }]));
  assert.ok(result.point && result.point.x < 625);
});

test('whole row covered: move first; never click on stale geometry', () => {
  const l = layout([{ x: 480, y: 80, width: 500, height: 500 }]);
  assert.deepEqual(sessionPoint(row, win, l).move, { x: 0, y: 80 });
  assert.throws(() => sessionPoint(row, win, l, false), /遮挡/);
  assert.throws(() => sessionPoint(row, win, { ...l, bounds: { ...win, x: 20 } }), /位置/);
});

test('no exposed destination means no click', () => {
  assert.throws(() => sessionPoint(row, win, layout([screen])), /遮挡/);
});
