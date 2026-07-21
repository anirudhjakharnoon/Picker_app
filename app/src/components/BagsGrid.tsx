import { CheckIcon } from './icons';

/**
 * Visual bag-collection progress used on the pickup confirmation screens
 * (matches the reference UI): collected bags render as a filled paper bag with
 * a green check; remaining bags render faded with an empty marker.
 */
export function BagsGrid({ total, collected }: { total: number; collected: number }) {
  const bags = Array.from({ length: total }, (_, i) => i < collected);
  return (
    <div className="bags-grid" role="img" aria-label={`${collected} of ${total} bags collected`}>
      {bags.map((done, i) => (
        <div key={i} className={`bag-cell ${done ? 'done' : 'pending'}`}>
          <BagGlyph done={done} />
          <span className={`bag-badge ${done ? 'done' : ''}`}>
            {done ? <CheckIcon size={14} /> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

function BagGlyph({ done }: { done: boolean }) {
  return (
    <svg viewBox="0 0 64 64" width="72" height="72" aria-hidden="true">
      <path
        d="M14 22c0-2 1.5-4 4-5l6-3h24l6 3c2.5 1 4 3 4 5v30a6 6 0 0 1-6 6H20a6 6 0 0 1-6-6V22Z"
        fill={done ? '#c88a3f' : '#e7e4de'}
      />
      <path
        d="M14 22c6 3 12 4 18 4s12-1 18-4"
        fill="none"
        stroke={done ? '#a96f2c' : '#d3cfc6'}
        strokeWidth="2.5"
      />
      <circle cx="24" cy="17" r="3.5" fill={done ? '#f0ede7' : '#f4f2ee'} />
    </svg>
  );
}
