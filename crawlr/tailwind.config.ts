import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        void: {
          950: "#02040a",
          900: "#050810",
          800: "#0a0f1c",
          700: "#101828",
        },
        signal: {
          green: "#39ff88",
          cyan: "#22e8ff",
          amber: "#ffb020",
          red: "#ff3b5c",
          violet: "#8b5cf6",
        },
      },
      fontFamily: {
        mono: [
          "JetBrains Mono",
          "IBM Plex Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
        display: ["Chakra Petch", "Rajdhani", "Inter", "sans-serif"],
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(57,255,136,0.25), 0 0 24px -4px rgba(57,255,136,0.45)",
        "glow-cyan": "0 0 0 1px rgba(34,232,255,0.25), 0 0 24px -4px rgba(34,232,255,0.45)",
        "glow-red": "0 0 0 1px rgba(255,59,92,0.3), 0 0 24px -4px rgba(255,59,92,0.5)",
      },
      keyframes: {
        scanline: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100vh)" },
        },
        marquee: {
          "0%": { transform: "translateX(0%)" },
          "100%": { transform: "translateX(-50%)" },
        },
        "pulse-ring": {
          "0%": { transform: "scale(0.8)", opacity: "0.9" },
          "80%": { transform: "scale(1.8)", opacity: "0" },
          "100%": { transform: "scale(1.8)", opacity: "0" },
        },
        "node-pop": {
          "0%": { transform: "scale(0)", opacity: "0" },
          "60%": { transform: "scale(1.25)", opacity: "1" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        drift: {
          "0%": { transform: "translate3d(0,0,0)" },
          "100%": { transform: "translate3d(-12px,-18px,0)" },
        },
        flicker: {
          "0%, 100%": { opacity: "1" },
          "45%": { opacity: "0.86" },
          "50%": { opacity: "1" },
          "72%": { opacity: "0.92" },
        },
      },
      animation: {
        scanline: "scanline 6s linear infinite",
        marquee: "marquee 22s linear infinite",
        "pulse-ring": "pulse-ring 2.2s cubic-bezier(0.2,0.6,0.4,1) infinite",
        "node-pop": "node-pop 0.4s cubic-bezier(0.2,0.9,0.3,1.3) forwards",
        drift: "drift 9s ease-in-out infinite alternate",
        flicker: "flicker 4.5s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
