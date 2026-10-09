// Colour bands for force readings. Thresholds are in kg whatever unit is shown.

export const BANDS = [
  { from: 10, color: '#1c7ed6' },
  { from: 15, color: '#0c9aa8' },
  { from: 20, color: '#2f9e44' },
  { from: 25, color: '#f08c00' },
  { from: 32, color: '#e03131' },
  { from: 45, color: '#9c36b5' },
];

/** Colour for readings below the first band, where a colour is needed. */
export const BELOW_BANDS_COLOR = '#5c636e';

/** Colour of the highest band reached, or null below the first one. */
export function bandColor(kg) {
  let color = null;
  for (const band of BANDS) {
    if (kg >= band.from) color = band.color;
  }
  return color;
}
