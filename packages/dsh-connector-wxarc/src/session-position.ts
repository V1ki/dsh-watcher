export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopLayout {
  bounds: Rect;
  usable: Rect[];
  covers: Rect[];
}

export interface SessionPointResult {
  point?: Point;
  move?: Point;
}

const RECT_KEYS = ['x', 'y', 'width', 'height'] as const;

const inside = (p: Point, r: Rect): boolean =>
  p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;

const fits = (a: Rect, b: Rect): boolean =>
  a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;

function isValidRect(r: Rect | null | undefined): r is Rect {
  return Boolean(
    r &&
    RECT_KEYS.every((k) => Number.isFinite(r[k])) &&
    r.width > 0 &&
    r.height > 0,
  );
}

export function sessionPoint(
  row: Rect | null | undefined,
  win: Rect | null | undefined,
  { bounds, usable, covers }: DesktopLayout,
  allowMove = true,
): SessionPointResult {
  if (
    !isValidRect(row) ||
    !isValidRect(win) ||
    !isValidRect(bounds) ||
    !Object.keys(bounds).every(
      (k) => (bounds as unknown as Record<string, unknown>)[k] === (win as unknown as Record<string, unknown>)[k],
    ) ||
    !fits(row, win)
  ) {
    throw Error('微信窗口或会话行位置已改变');
  }
  const validRow = row;
  const validWin = win;
  function pick(x: number, y: number): Point | undefined {
    for (const fx of [0.5, 0.25, 0.75, 0.1, 0.9]) {
      for (const fy of [0.5, 0.25, 0.75]) {
        const p: Point = {
          x: x + validRow.x - validWin.x + validRow.width * fx,
          y: y + validRow.y - validWin.y + validRow.height * fy,
        };
        if (usable.some((r) => inside(p, r)) && !covers.some((r) => inside(p, r))) {
          return p;
        }
      }
    }
    return undefined;
  }
  const point = pick(validWin.x, validWin.y);
  if (point) return { point };
  if (allowMove) {
    for (const d of usable) {
      for (const x of [d.x, d.x + d.width - validWin.width]) {
        for (const y of [validWin.y, d.y, d.y + d.height - validWin.height]) {
          if (fits({ ...validWin, x, y }, d) && pick(x, y)) {
            return { move: { x, y } };
          }
        }
      }
    }
  }
  throw Error('微信会话列表被遮挡，没有可核对的点击位置；未点击或发送');
}
