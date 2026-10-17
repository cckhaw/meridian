module.exports = {
  // hover styles apply only where there is a hover, so a tap on a touch screen is a click and not a first "hover" tap
  future: { hoverOnlyWhenSupported: true },
  presets: [require('@meridian/ui/tailwind-preset')],
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
};
