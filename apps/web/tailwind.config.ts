import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans Arabic"', "system-ui", "sans-serif"],
      },
      colors: {
        // Busna brand green. Schools can override --brand at runtime.
        brand: {
          50: "#ECFDF5",
          100: "#D1FAE5",
          200: "#A7F3D0",
          300: "#6EE7B7",
          400: "#34D399",
          500: "#10B981",
          600: "rgb(var(--brand-rgb) / <alpha-value>)",
          700: "#047857",
          800: "#065F46",
          900: "#064E3B",
        },
        ink: {
          DEFAULT: "#0F172A",
          muted: "#475569",
          soft: "#64748B",
        },
        line: "#E2E8F0",
        surface: "#F8FAFC",
      },
      borderRadius: { xl: "0.875rem", "2xl": "1.125rem" },
      boxShadow: {
        card: "0 1px 2px rgb(15 23 42 / 0.04), 0 1px 3px rgb(15 23 42 / 0.06)",
        pop: "0 10px 30px -10px rgb(15 23 42 / 0.25)",
      },
    },
  },
  plugins: [],
} satisfies Config;
