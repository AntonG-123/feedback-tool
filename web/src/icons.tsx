// Minimal stroke icon set (24px grid, 1.75 stroke), drawn for this app.
const P = (d: string | string[]) => (props: { size?: number; className?: string }) => (
  <svg width={props.size || 18} height={props.size || 18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={props.className} aria-hidden="true">
    {(Array.isArray(d) ? d : [d]).map((x, i) => <path key={i} d={x} />)}
  </svg>
);

export const Icon = {
  back: P('M15 18l-6-6 6-6'),
  chevron: P('M9 18l6-6-6-6'),
  down: P('M6 9l6 6 6-6'),
  desktop: P(['M3 5h18v11H3z', 'M8 20h8', 'M12 16v4']),
  tablet: P(['M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M11 18h2']),
  mobile: P(['M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M11 18h2']),
  cursor: P('M5 3l14 7-6 2-2 6z'),
  comment: P('M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z'),
  eye: P(['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z']),
  eyeOff: P(['M3 3l18 18', 'M10.6 5.1A9.7 9.7 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1', 'M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6', 'M9.9 9.9a3 3 0 0 0 4.2 4.2']),
  expand: P(['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5']),
  shrink: P(['M9 4v5H4', 'M15 4v5h5', 'M9 20v-5H4', 'M15 20v-5h5']),
  share: P(['M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7', 'M16 6l-4-4-4 4', 'M12 2v13']),
  settings: P(['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z']),
  check: P('M20 6L9 17l-5-5'),
  checkCircle: P(['M22 11.1V12a10 10 0 1 1-5.9-9.1', 'M22 4L12 14l-3-3']),
  x: P(['M18 6L6 18', 'M6 6l12 12']),
  more: P(['M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z']),
  image: P(['M4 4h16v16H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2z']),
  mic: P(['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M19 11a7 7 0 0 1-14 0', 'M12 18v3']),
  stop: P('M7 7h10v10H7z'),
  pen: P(['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z']),
  arrow: P(['M5 19L19 5', 'M9 5h10v10']),
  circle: P('M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'),
  rect: P('M4 6h16v12H4z'),
  free: P('M3 17c3-6 5-9 7-9s1 6 4 6 4-5 7-7'),
  undo: P(['M9 14L4 9l5-5', 'M4 9h11a5 5 0 0 1 0 10h-2']),
  trash: P(['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14']),
  reload: P(['M21 12a9 9 0 1 1-2.6-6.4', 'M21 3v6h-6']),
  external: P(['M14 4h6v6', 'M10 14L20 4', 'M20 14v6H4V4h6']),
  download: P(['M12 3v12', 'M7 10l5 5 5-5', 'M4 21h16']),
  list: P(['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01']),
  file: P(['M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z', 'M14 3v5h5']),
  folder: P('M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z'),
  search: P(['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3']),
  plus: P(['M12 5v14', 'M5 12h14']),
  copy: P(['M9 9h11v11H9z', 'M5 15H4V4h11v1']),
  link: P(['M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7', 'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7']),
  logout: P(['M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4', 'M16 17l5-5-5-5', 'M21 12H9']),
  alert: P(['M12 9v4', 'M12 17h.01', 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z']),
};

export function Logo() {
  return (
    <span className="brand">
      <span className="brand-mark">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><path d="M12 3C7 3 3 6.6 3 11c0 2.4 1.2 4.6 3.1 6L5.5 21l4.3-2.2c.7.1 1.4.2 2.2.2 5 0 9-3.6 9-8s-4-8-9-8z" /></svg>
      </span>
      AGM Feedback
    </span>
  );
}
