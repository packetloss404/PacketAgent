/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ["Geist", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        serif: ["Instrument Serif", "ui-serif", "Georgia", "serif"],
        mono: ["Geist Mono", "ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      letterSpacing: {
        kicker: "0.14em",
      },
      colors: {
        // Ink scale remapped to the design's silver / grey foundation.
        // Names preserved (ink.950 .. ink.100) so existing className refs keep working;
        // values now follow the silver/grey/green-light system from the design package.
        ink: {
          950: "#060708",
          900: "#0A0C0D",
          875: "#0E1112",
          850: "#14181A",
          800: "#181C1E",
          750: "#1E2225",
          700: "#262B2E",
          600: "#2F3539",
          500: "#3A4146",
          400: "#4A5054",
          300: "#686E72",
          200: "#8A9094",
          100: "#B5BBBE",
          50: "#DCE0E2",
          0: "#F2F4F5",
        },
        signal: {
          amber: "#B8F25C",
          amberDim: "#5C8A1F",
          red: "#F26B5C",
          green: "#B8F25C",
          warn: "#F2C45C",
          info: "#6BB5F2",
        },
        accent: {
          300: "#D8FA9E",
          400: "#B8F25C",
          500: "#B8F25C",
          600: "#5C8A1F",
        },
        paper: "#F2F4F5",
      },
      borderRadius: {
        none: "0",
        sm: "6px",
        DEFAULT: "8px",
        md: "8px",
        lg: "10px",
        xl: "14px",
        "2xl": "20px",
        "3xl": "24px",
        full: "9999px",
      },
      boxShadow: {
        card: "0 1px 0 rgba(255,255,255,0.025) inset",
        edge: "inset 0 -1px 0 #262B2E",
        glow: "0 0 0 3px rgba(184,242,92,0.08)",
      },
      backgroundImage: {
        "graph-paper":
          "linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)",
        noise:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.06 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
      },
      backgroundSize: {
        "grid-32": "28px 28px",
        "grid-16": "16px 16px",
      },
    },
  },
  plugins: [],
};
