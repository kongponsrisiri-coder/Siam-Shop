import React from 'react';

// SiamShop logo — part of the SiamEPOS brand family (see restaurant-epos/BRAND_CI.md).
// The mark is the shared geometric 5-petal lotus in a double gold ring; the
// wordmark is adapted to "SiamShop" (Georgia serif, "Siam" + gold "Shop").

const GOLD = '#C9A84C';
const NAVY = '#0D1B3E';

// The lotus badge icon mark. `center` is the colour of the centre hollow —
// navy on dark backgrounds, the page colour on light ones.
export function LotusBadge({ size = 32, center = NAVY, title = 'SiamShop' }) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role="img"
      aria-label={title}
      style={{ display: 'block', flex: '0 0 auto' }}
    >
      <circle cx="50" cy="50" r="45" fill="none" stroke={GOLD} strokeWidth="1.8" />
      <circle cx="50" cy="50" r="39" fill="none" stroke={GOLD} strokeWidth="0.6" opacity="0.28" />
      <g transform="translate(50,50)">
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill={GOLD} />
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill={GOLD} opacity="0.82" transform="rotate(72)" />
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill={GOLD} opacity="0.62" transform="rotate(144)" />
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill={GOLD} opacity="0.62" transform="rotate(216)" />
        <path d="M 0,5 C -10,-8 -8,-36 0,-42 C 8,-36 10,-8 0,5 Z" fill={GOLD} opacity="0.82" transform="rotate(288)" />
        <circle cx="0" cy="0" r="9" fill={center} />
        <circle cx="0" cy="0" r="5" fill={GOLD} />
      </g>
    </svg>
  );
}

// Lotus badge + "SiamShop" wordmark, lockup. `light` = on a light background
// (navy "Siam"); default is for dark backgrounds (white "Siam").
export function Logo({ size = 30, light = false, wordmark = true }) {
  const siam = light ? NAVY : '#ffffff';
  const center = light ? '#ffffff' : NAVY;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
      <LotusBadge size={size} center={center} />
      {wordmark && (
        <span
          style={{
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontSize: Math.round(size * 0.66),
            fontWeight: 700,
            letterSpacing: '-0.5px',
            lineHeight: 1,
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ color: siam }}>Siam</span>
          <span style={{ color: GOLD }}>Shop</span>
        </span>
      )}
    </span>
  );
}

export default Logo;
