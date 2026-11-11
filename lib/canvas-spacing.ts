type Box = { x: number; y: number; w: number; h: number };
type Axis = "x" | "y";
type Span = { start: number; end: number; low: number; high: number };
export type GapGuide = { axis: Axis; start: number; end: number; cross: number };
type Snap = { offset: number; guides: GapGuide[] };

export function equalSpacing(box: Box, others: Box[], axis: Axis, tolerance: number): Snap | undefined {
  const project = (n: Box): Span => axis === "x"
    ? { start: n.x, end: n.x + n.w, low: n.y, high: n.y + n.h }
    : { start: n.y, end: n.y + n.h, low: n.x, high: n.x + n.w };
  const m = project(box);
  const row = others.map(project).filter((n) => n.low < m.high && n.high > m.low);
  const left = row.filter((n) => n.end <= m.start).sort((a, b) => b.end - a.end);
  const right = row.filter((n) => n.start >= m.end).sort((a, b) => a.start - b.start);
  let best: Snap | undefined;
  function consider(a?: Span, b?: Span, c?: Span) {
    if (!a || !b || !c) return;
    const low = Math.max(a.low, b.low, c.low), high = Math.min(a.high, b.high, c.high);
    if (low >= high) return;
    const gap1 = b.start - a.end, gap2 = c.start - b.end;
    const offset = b === m ? (gap2 - gap1) / 2 : gap1 - gap2;
    if (Math.min(gap1, gap2) <= 0 || Math.abs(offset) > tolerance || (best && Math.abs(offset) >= Math.abs(best.offset))) return;
    const cross = (low + high) / 2;
    const draw = (from: Span, to: Span): GapGuide => ({
      axis, cross, start: from.end + (from === m ? offset : 0), end: to.start + (to === m ? offset : 0),
    });
    best = { offset, guides: [draw(a, b), draw(b, c)] };
  }
  const first = left[0], last = right[0];
  consider(first, m, last);
  if (first) consider(left.find((n) => n.end < first.start && n.low < first.high && n.high > first.low), first, m);
  if (last) consider(m, last, right.find((n) => n.start > last.end && n.low < last.high && n.high > last.low));
  return best;
}
