/**
 * Hand-drawn SVG icons for the HUD. Everything is a flat white silhouette (fill="currentColor")
 * so CSS controls colour; weapons face right like CoD kill-feed / HUD icons.
 */

export type WeaponKind = 'rifle' | 'smg' | 'pistol' | 'shotgun' | 'sniper' | 'lmg';

const W = (vb: string, body: string) =>
  `<svg viewBox="${vb}" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>`;

const RIFLE = W('0 0 252 76', `
  <path d="M4 29 L18 25.5 L56 28 L56 41 L38 42.5 L22 50 L4 52 Z"/>
  <path d="M56 30.5 H72 V39.5 H56 Z"/>
  <path d="M70 25 H152 V42 H70 Z"/>
  <path d="M76 20.5 H196 V25 H76 Z"/>
  <path d="M98 6 H132 L136 10 V17 H96 V10 Z M104 17 H110 V20.5 H104 Z M120 17 H126 V20.5 H120 Z"/>
  <path d="M84 42 H99 L93 66 L78 64.5 Z"/>
  <path fill-rule="evenodd" d="M97 42 H116 L114 50 H99 Z M101 42.8 H112 L111 47.5 H101 Z"/>
  <path d="M116 42 H133 L139 69 L122 71.5 Z"/>
  <path fill-rule="evenodd" d="M152 22.5 H199 V41 H152 Z M158 29 H167 V34 H158 Z M172 29 H181 V34 H172 Z M186 29 H194 V34 H186 Z"/>
  <path d="M190 12 H196 V22.5 H190 Z"/>
  <path d="M199 29 H232 V34.5 H199 Z"/>
  <path d="M230 26.5 H248 V37 H230 Z"/>
  <path d="M140 25 H150 V28 H140 Z"/>`);

const SMG = W('0 0 216 76', `
  <path d="M4 27 H14 L42 26 V38 L22 47 H4 Z M10 31 V43 H18 L34 36 V31 Z" fill-rule="evenodd"/>
  <path d="M40 23 H150 V38 H40 Z"/>
  <path d="M50 15 H60 V23 H50 Z"/>
  <path d="M78 38 H93 L88 62 H73 Z"/>
  <path fill-rule="evenodd" d="M92 38 H108 L106 45 H93 Z M96 38.8 H105 L104 43 H96 Z"/>
  <path d="M110 38 H124 L134 66 L121 68.5 Z"/>
  <path d="M150 25 H182 V39 H150 Z"/>
  <path d="M176 15 H183 V25 H176 Z"/>
  <path d="M182 28.5 H210 V34 H182 Z"/>`);

const PISTOL = W('0 0 132 80', `
  <path d="M8 16 H122 V33 H8 Z"/>
  <path d="M12 13 H20 V16 H12 Z M110 12 H116 V16 H110 Z"/>
  <path d="M26 33 H116 V40 H26 Z"/>
  <path d="M18 33 H50 L46 44 L42 74 H14 L16 46 Z"/>
  <path fill-rule="evenodd" d="M48 40 H74 L70 53 H47 Z M52 40.8 H68 L66 49 H51.5 Z"/>`);

const SHOTGUN = W('0 0 260 76', `
  <path d="M4 32 L60 27 L64 41 L38 44 L16 53 H4 Z"/>
  <path d="M60 25 H122 V42 H66 Z"/>
  <path d="M64 41 H80 L74 60 H60 Z"/>
  <path fill-rule="evenodd" d="M80 42 H100 L98 49 H81 Z M84 42.8 H96 L95 46.5 H84 Z"/>
  <path d="M122 25 H254 V31 H122 Z"/>
  <path d="M122 33 H226 V39 H122 Z"/>
  <path d="M146 31.5 H198 V45 H146 Z"/>
  <path d="M248 21 H252 V25 H248 Z"/>`);

const SNIPER = W('0 0 290 76', `
  <path d="M4 28 L22 24 L84 29 V42 L54 44 L32 55 H4 Z"/>
  <path d="M84 27 H160 V41 H84 Z"/>
  <path d="M84 6 H98 V22 H84 Z M98 9.5 H146 V18.5 H98 Z M146 5 H164 V23 H146 Z M104 18 H112 V27 H104 Z M132 18 H140 V27 H132 Z"/>
  <path d="M94 41 H108 L102 62 H88 Z"/>
  <path d="M116 41 H132 V56 H116 Z"/>
  <path d="M160 30 H274 V36 H160 Z"/>
  <path d="M272 27.5 H286 V38.5 H272 Z"/>
  <path d="M176 36 L180 36 L168 64 L164 64 Z M182 36 L186 36 L196 64 L192 64 Z"/>`);

const LMG = W('0 0 268 80', `
  <path d="M4 28 L20 24 L58 28 V42 L40 44 L22 52 H4 Z"/>
  <path d="M58 24 H160 V42 H58 Z"/>
  <path d="M66 19 H172 V24 H66 Z"/>
  <path d="M84 42 H99 L93 66 L78 64 Z"/>
  <path d="M106 42 H146 V68 H106 Z"/>
  <path d="M160 23 H212 V40 H160 Z"/>
  <path d="M212 29 H252 V34 H212 Z M250 26.5 H264 V37 H250 Z"/>
  <path d="M200 40 L204 40 L190 70 L186 70 Z M206 40 L210 40 L222 70 L218 70 Z"/>`);

export const WEAPON_ICONS: Record<WeaponKind, string> = {
  rifle: RIFLE, smg: SMG, pistol: PISTOL, shotgun: SHOTGUN, sniper: SNIPER, lmg: LMG,
};

/** Frag grenade (lethal). */
export const ICON_FRAG = W('0 0 32 32', `
  <path d="M13 4 H19 V7.5 H13 Z"/>
  <path d="M19 5 C24 5 27 7 27.5 10 L25.5 10.5 C24.8 8.5 22.5 7.4 19 7.4 Z"/>
  <path fill-rule="evenodd" d="M16 8 C22 8 25.5 12.5 25.5 18.5 C25.5 24.8 21.5 29 16 29 C10.5 29 6.5 24.8 6.5 18.5 C6.5 12.5 10 8 16 8 Z
    M9 17 H23 V18.6 H9 Z M9 22 H23 V23.6 H9 Z M15.2 10 H16.8 V27 H15.2 Z"/>`);

/** Stun / flash grenade (tactical). */
export const ICON_FLASH = W('0 0 32 32', `
  <path d="M12 3 H20 V6 H12 Z"/>
  <path d="M20 4 L26 7 L25 9 L20 6.5 Z"/>
  <path fill-rule="evenodd" d="M9 7 H23 V29 H9 Z M11 11 H21 V12.6 H11 Z M11 15 H21 V16.6 H11 Z M11 23 H21 V24.6 H11 Z"/>`);

/** Headshot: head silhouette with a reticle notch. */
export const ICON_HEADSHOT = W('0 0 32 32', `
  <path fill-rule="evenodd" d="M16 3 C22.5 3 26 7.6 26 13.4 C26 17 24.6 19.6 22.6 21.2 V26 H9.4 V21.2 C7.4 19.6 6 17 6 13.4 C6 7.6 9.5 3 16 3 Z
    M11.8 12.4 A2.6 2.6 0 1 0 11.81 12.4 Z M20.2 12.4 A2.6 2.6 0 1 0 20.21 12.4 Z" transform="translate(0 0)"/>
  <path d="M13 28 H19 V30 H13 Z"/>`);

/** Generic skull for kill feed "killed by" / death card. */
export const ICON_SKULL = W('0 0 32 32', `
  <path fill-rule="evenodd" d="M16 2.5 C23 2.5 27 7.2 27 13.2 C27 17 25.3 19.8 23 21.4 V25.5 H9 V21.4 C6.7 19.8 5 17 5 13.2 C5 7.2 9 2.5 16 2.5 Z
    M11.5 11 C13.6 11 14.6 12.6 14.2 14.6 C13.8 16.3 12.4 17 11 16.8 C9.6 16.6 8.8 15.3 9 13.9 C9.2 12.2 10.1 11 11.5 11 Z
    M20.5 11 C21.9 11 22.8 12.2 23 13.9 C23.2 15.3 22.4 16.6 21 16.8 C19.6 17 18.2 16.3 17.8 14.6 C17.4 12.6 18.4 11 20.5 11 Z
    M16 17.5 L17.6 20.4 H14.4 Z"/>
  <path d="M10 26.5 H13 V29.5 H10 Z M14.5 26.5 H17.5 V29.5 H14.5 Z M19 26.5 H22 V29.5 H19 Z"/>`);

/** Single round, used for fire-mode readout. */
export const ICON_ROUND = `<svg viewBox="0 0 8 24" fill="currentColor" aria-hidden="true"><path d="M1 9 C1 4.5 2.4 1.5 4 0.5 C5.6 1.5 7 4.5 7 9 V22 H1 Z"/></svg>`;

/** Player position arrow for minimap. */
export const ICON_PLAYER_ARROW = W('0 0 24 24', `<path d="M12 2 L20 21 L12 16.5 L4 21 Z"/>`);

/** Objective diamond. */
export const ICON_OBJECTIVE = W('0 0 16 16', `<path fill-rule="evenodd" d="M8 0.5 L15.5 8 L8 15.5 L0.5 8 Z M8 4 L4 8 L8 12 L12 8 Z"/>`);

/** Brand mark: slanted S-block. */
export const ICON_BRAND = W('0 0 40 40', `
  <path d="M8 4 H36 L32 12 H14.5 L13 15 H30 L24 36 H2 L6 28 H20.5 L22 25 H6 Z"/>`);

/** Right-pointing chevron arrow. */
export const ICON_CHEVRON = W('0 0 16 16', `<path d="M5 2 L11.5 8 L5 14 L3.2 12.2 L7.8 8 L3.2 3.8 Z"/>`);

/** Medal badge (multi-kill) — frame drawn, number overlaid in DOM. */
export function medalSvg(tier: number, color: string): string {
  const pips = Array.from({ length: Math.min(tier, 5) }, (_, i) => {
    const x = 32 - (Math.min(tier, 5) - 1) * 4 + i * 8;
    return `<path d="M${x - 2.6} 56 L${x} 53 L${x + 2.6} 56 L${x} 59 Z"/>`;
  }).join('');
  return `<svg viewBox="0 0 64 64" aria-hidden="true">
    <path d="M32 2 L58 14 V34 C58 46 46 56 32 62 C18 56 6 46 6 34 V14 Z" fill="rgba(10,12,12,0.72)" stroke="${color}" stroke-width="2.4"/>
    <path d="M32 9 L51 18 V33 C51 42 43 49 32 54 C21 49 13 42 13 33 V18 Z" fill="none" stroke="${color}" stroke-opacity="0.45" stroke-width="1"/>
    <path d="M18 24 L32 31 L46 24 V30 L32 37 L18 30 Z M18 33 L32 40 L46 33 V39 L32 46 L18 39 Z" fill="${color}"/>
    <g fill="${color}">${pips}</g>
  </svg>`;
}

/** Damage-direction wedge. Drawn pointing up; rotated around the screen centre by CSS. */
export const DAMAGE_ARC = `<svg viewBox="-100 -100 200 200" aria-hidden="true">
  <defs>
    <radialGradient id="shDmgGrad" cx="0" cy="0" r="100" gradientUnits="userSpaceOnUse">
      <stop offset="0.62" stop-color="#ff2a1a" stop-opacity="0"/>
      <stop offset="0.8" stop-color="#ff2a1a" stop-opacity="0.95"/>
      <stop offset="0.92" stop-color="#b40c05" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#b40c05" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="shDmgFade" x1="-1" y1="0" x2="1" y2="0" gradientUnits="objectBoundingBox">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#fff" stop-opacity="1"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <path d="M-38.5 -86.5 A95 95 0 0 1 38.5 -86.5 L27.6 -62 A68 68 0 0 0 -27.6 -62 Z" fill="url(#shDmgGrad)"/>
  <path d="M-8 -66 L0 -73 L8 -66 L0 -69.5 Z" fill="#ff5040" fill-opacity="0.9"/>
</svg>`;
