import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#0a0a0b",
          900: "#111113",
          800: "#1a1a1e",
          700: "#25252b",
          600: "#3a3a44",
          400: "#8b8b9a",
          200: "#c8c8d4",
          50: "#f4f4f7",
        },
        accent: {
          DEFAULT: "#7c5cff",
          soft: "#a78bfa",
          glow: "#c4b5fd",
        },
        mint: "#5eead4",
      },
      fontFamily: {
        display: ["'Segoe UI'", "system-ui", "sans-serif"],
        body: ["'Segoe UI'", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        card: "0 0 0 1px rgba(255,255,255,0.06), 0 20px 50px rgba(0,0,0,0.45)",
        glow: "0 0 40px rgba(124,92,255,0.25)",
      },
    },
  },
  plugins: [],
};
export default config;
