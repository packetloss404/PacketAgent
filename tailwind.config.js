/** @type {import('tailwindcss').Config} */
export default {
  content: ["./web/index.html", "./web/src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "IBM Plex Sans",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        serif: ["Fraunces", "ui-serif", "Georgia", "serif"],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      letterSpacing: {
        kicker: "0.22em",
      },
      colors: {
        ink: {
          950: "#070809",
          900: "#0c0d10",
          875: "#101116",
          850: "#14151a",
          800: "#1a1c22",
          750: "#21232a",
          700: "#2a2c34",
          600: "#3a3c45",
          500: "#5a5c66",
          400: "#80828d",
          300: "#a7a9b3",
          200: "#cdced4",
          100: "#ebebef",
        },
        signal: {
          amber: "#ffb000",
          amberDim: "#b87a00",
          red: "#ff3b30",
          green: "#00d68f",
        },
        accent: {
          300: "#ffb000",
          400: "#ffb000",
          500: "#ffb000",
          600: "#cc8c00",
        },
        paper: "#f1ece1",
      },
      borderRadius: {
        none: "0",
        sm: "1px",
        DEFAULT: "2px",
        md: "2px",
        lg: "2px",
        xl: "2px",
        "2xl": "2px",
        "3xl": "2px",
        full: "9999px",
      },
      boxShadow: {
        card: "0 1px 0 rgba(255,255,255,0.02) inset",
        edge: "inset 0 -1px 0 #2a2c34",
      },
      backgroundImage: {
        "graph-paper":
          "linear-gradient(rgba(42,44,52,0.45) 1px, transparent 1px), linear-gradient(90deg, rgba(42,44,52,0.45) 1px, transparent 1px)",
        noise:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.06 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
      },
      backgroundSize: {
        "grid-32": "32px 32px",
        "grid-16": "16px 16px",
      },
    },
  },
  plugins: [],
};
