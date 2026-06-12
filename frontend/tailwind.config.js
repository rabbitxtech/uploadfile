/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef6ff',
          100: '#d9eaff',
          200: '#bfdbfe',
          300: '#93c5fd',
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a',
        },
      },
      keyframes: {
        fadeIn: { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
        popIn: {
          '0%': { opacity: 0, transform: 'translateY(8px) scale(0.97)' },
          '100%': { opacity: 1, transform: 'translateY(0) scale(1)' },
        },
        slideIn: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        // Subtle "rise + fade" for list items / cards entering the viewport.
        fadeInUp: {
          '0%': { opacity: 0, transform: 'translateY(6px)' },
          '100%': { opacity: 1, transform: 'translateY(0)' },
        },
        // Skeleton loading sweep.
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      // Named utilities so components can use `animate-fade-in` etc. (the
      // existing arbitrary `animate-[fadeIn_…]` call sites keep working too).
      animation: {
        'fade-in': 'fadeIn 150ms ease-out',
        'pop-in': 'popIn 160ms cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in-up': 'fadeInUp 220ms cubic-bezier(0.16, 1, 0.3, 1) both',
        shimmer: 'shimmer 1.6s ease-in-out infinite',
      },
      transitionTimingFunction: {
        // A gentle ease-out-back-ish curve for snappy-but-soft motion.
        smooth: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
