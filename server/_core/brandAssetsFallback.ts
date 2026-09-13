// Preview-safe fallback derived from the existing PowerHub branding artwork in the project.
// This is only used when the private staging Storage object is missing.

const COMMON_ICON = `
  <g transform="translate(10 18)">
    <circle cx="58" cy="42" r="38" fill="none" stroke="#F5B81A" stroke-width="5" opacity="0.9"/>
    <path d="M20 72h70c4 0 7 3 7 7v3H13v-3c0-4 3-7 7-7Z" fill="#17191D" stroke="#F5B81A" stroke-width="4"/>
    <rect x="26" y="44" width="54" height="34" rx="4" fill="#22262B" stroke="#F5B81A" stroke-width="4"/>
    <path d="M34 52h12M34 58h12M34 64h12" stroke="#F5B81A" stroke-width="3" stroke-linecap="round"/>
    <rect x="50" y="52" width="22" height="20" rx="3" fill="#111317" stroke="#F5B81A" stroke-width="2"/>
    <path d="M63 28 52 48h9l-7 16 18-24h-9Z" fill="#F5B81A"/>
    <circle cx="92" cy="70" r="19" fill="#0E1114" stroke="#D7DADF" stroke-width="4"/>
    <text x="92" y="67" text-anchor="middle" font-family="Arial, sans-serif" font-size="8" font-weight="700" fill="#F5B81A">kWh</text>
    <text x="92" y="76" text-anchor="middle" font-family="Arial, sans-serif" font-size="9" font-weight="700" fill="#F5B81A">01234</text>
    <path d="M92 80v5" stroke="#F5B81A" stroke-width="2"/>
  </g>`;

export const POWERHUB_LIGHT_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="132" viewBox="0 0 640 132" role="img" aria-label="PowerHub">
  <rect width="640" height="132" fill="none"/>
  ${COMMON_ICON}
  <text x="150" y="82" font-family="Arial, Helvetica, sans-serif" font-size="68" font-style="italic" font-weight="800" fill="#2D333A">Power</text>
  <text x="408" y="82" font-family="Arial, Helvetica, sans-serif" font-size="68" font-style="italic" font-weight="800" fill="#F5B81A">Hub</text>
  <path d="M145 99h430" stroke="#F5B81A" stroke-width="3" stroke-linecap="round" opacity="0.95"/>
</svg>`;

export const POWERHUB_DARK_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="132" viewBox="0 0 640 132" role="img" aria-label="PowerHub">
  <rect width="640" height="132" fill="none"/>
  ${COMMON_ICON}
  <text x="150" y="82" font-family="Arial, Helvetica, sans-serif" font-size="68" font-style="italic" font-weight="800" fill="#FFFFFF">Power</text>
  <text x="408" y="82" font-family="Arial, Helvetica, sans-serif" font-size="68" font-style="italic" font-weight="800" fill="#F5B81A">Hub</text>
  <path d="M145 99h430" stroke="#F5B81A" stroke-width="3" stroke-linecap="round" opacity="0.95"/>
</svg>`;
