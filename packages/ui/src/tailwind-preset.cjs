/** @type {import('tailwindcss').Config} */
const c = (v) => `rgb(var(--${v}) / <alpha-value>)`;
module.exports = {
  darkMode: 'class',
  theme: {
    // Breakpoints: phone < 640 | tablet 640-1023 | desktop >= 1024
    screens: { sm: '640px', md: '768px', lg: '1024px', xl: '1280px', '2xl': '1536px' },
    extend: {
      colors: {
        bg: c('bg'), grouped: c('bg-grouped'), surface: c('surface'), surface2: c('surface-2'),
        label: c('label'), label2: c('label-2'), accent: c('accent'), 'accent-fg': c('accent-label'),
        success: c('success'), warning: c('warning'), danger: c('danger'),
        separator: 'rgb(var(--separator))',
      },
      borderRadius: { card: 'var(--radius-card)', control: 'var(--radius-control)' },
      minHeight: { tap: 'var(--tap)' },
      minWidth: { tap: 'var(--tap)' },
      // iOS Dynamic-Type-like scale
      fontSize: {
        caption: ['12px', '16px'], footnote: ['13px', '18px'], subhead: ['15px', '20px'], body: ['17px', '24px'],
        title3: ['20px', '25px'], title2: ['22px', '28px'], title1: ['28px', '34px'], 'large-title': ['34px', '41px'],
      },
      boxShadow: { card: '0 1px 2px rgb(0 0 0 / .04), 0 4px 16px rgb(0 0 0 / .06)' },
      backdropBlur: { chrome: '24px' },
    },
  },
};
