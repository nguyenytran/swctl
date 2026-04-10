/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#1a1d27',
          dark: '#0f1117',
          hover: '#222636',
        },
        border: '#2a2e3d',
      },
      fontFamily: {
        mono: ['"SF Mono"', '"Fira Code"', 'monospace'],
      },
    },
  },
  plugins: [],
}
