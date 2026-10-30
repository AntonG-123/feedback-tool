import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';

// Shapes are kept in DOCUMENT coordinates of the previewed page so they stay
// attached to the content when the reviewer scrolls the page while drawing.
export type Shape = { type: 'arrow' | 'circle' | 'rect' | 'free'; color: string; width: number; points: { x: number; y: number }[] };
export const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#111827'];

export function drawShape(ctx: CanvasRenderingContext2D, s: Shape, ox: number, oy: number) {
  const pts = s.points.map((p) => ({ x: p.x - ox, y: p.y - oy }));
  if (!pts.length) return;
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const a = pts[0], b = pts[pts.length - 1];
  if (s.type === 'rect') ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  else if (s.type === 'circle') {
    ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (s.type === 'arrow') {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    const ang = Math.atan2(b.y - a.y, b.x - a.x), L = 10 + s.width * 3;
    ctx.moveTo(b.x - L * Math.cos(ang - 0.45), b.y - L * Math.sin(ang - 0.45));
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(b.x - L * Math.cos(ang + 0.45), b.y - L * Math.sin(ang + 0.45));
    ctx.stroke();
  } else {
    ctx.moveTo(a.x, a.y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
}

type Props = {
  active: boolean;
  shapes: Shape[];
  setShapes: (s: Shape[]) => void;
  scroll: { x: number; y: number };
  onScroll: (dx: number, dy: number) => void;
  onDone: () => void;
};

export function DrawingLayer({ active, shapes, setShapes, scroll, onScroll, onDone }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Shape['type']>('arrow');
  const [color, setColor] = useState(COLORS[0]);
  const cur = useRef<Shape | null>(null);
  const [, force] = useState(0);

  const redraw = () => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const s of [...shapes, ...(cur.current ? [cur.current] : [])]) drawShape(ctx, s, scroll.x, scroll.y);
  };
  useEffect(redraw);
  useEffect(() => {
    const ro = new ResizeObserver(redraw);
    if (canvas.current) ro.observe(canvas.current);
    return () => ro.disconnect();
  });

  const pt = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left + scroll.x, y: e.clientY - r.top + scroll.y };
  };
  const down = (e: React.PointerEvent) => {
    if (!active) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    cur.current = { type: tool, color, width: 4, points: [pt(e)] };
    force((x) => x + 1);
  };
  const move = (e: React.PointerEvent) => {
    if (!cur.current) return;
    const p = pt(e);
    if (cur.current.type === 'free') cur.current.points.push(p);
    else cur.current.points = [cur.current.points[0], p];
    redraw();
  };
  const up = () => {
    const s = cur.current;
    cur.current = null;
    if (!s) return;
    const a = s.points[0], b = s.points[s.points.length - 1];
    if (s.type === 'free' ? s.points.length > 2 : Math.hypot(b.x - a.x, b.y - a.y) > 6) setShapes([...shapes, s]);
    else force((x) => x + 1);
  };

  return (
    <>
      <div className={active ? 'draw-layer' : 'layer'} style={{ zIndex: active ? 15 : 14 }} data-testid={active ? 'draw-layer' : undefined}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        onWheel={active ? (e) => onScroll(e.deltaX, e.deltaY) : undefined}>
        <canvas ref={canvas} style={{ width: '100%', height: '100%', display: 'block' }} />
      </div>
      {active && (
        <>
          <div className="draw-bar" data-testid="draw-bar">
            {(['arrow', 'circle', 'rect', 'free'] as const).map((t) => {
              const I = Icon[t];
              return <button key={t} className={`icon-btn ${tool === t ? 'active' : ''}`} title={{ arrow: 'Arrow', circle: 'Circle', rect: 'Rectangle', free: 'Freehand' }[t]} onClick={() => setTool(t)} data-testid={`tool-${t}`}><I /></button>;
            })}
            <span className="vsep" />
            {COLORS.map((c) => <span key={c} className={`swatch ${color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} role="button" aria-label={`Color ${c}`} />)}
            <span className="vsep" />
            <button className="icon-btn" title="Undo" onClick={() => setShapes(shapes.slice(0, -1))} disabled={!shapes.length}><Icon.undo /></button>
            <button className="icon-btn" title="Clear drawing" onClick={() => setShapes([])} disabled={!shapes.length}><Icon.trash /></button>
            <button className="btn btn-primary btn-sm" style={{ marginLeft: 4 }} onClick={onDone} data-testid="draw-done">Done</button>
          </div>
        </>
      )}
    </>
  );
}
