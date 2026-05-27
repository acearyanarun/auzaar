import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        bg: "#060d18",
        surface: { 1: "#0c1526", 2: "#101e33", 3: "#142236" },
        accent: "#00c8ff",
        green: "#00e5a0",
        critical: "#ff3d5a",
        high: "#ff8800",
        medium: "#f0c000",
        purple: "#a78bfa",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Menlo", "monospace"],
      },
      animation: {
        "pulse-dot": "pulseDot 1.5s infinite",
        "slide-in": "slideIn 0.3s ease forwards",
        "flash-red": "flashRed 1s ease",
      },
      keyframes: {
        pulseDot: {
          "0%, 100%": { boxShadow: "0 0 0 0 rgba(255,61,90,0.5)" },
          "60%": { boxShadow: "0 0 0 6px rgba(255,61,90,0)" },
        },
        slideIn: {
          from: { opacity: "0", transform: "translateY(-8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        flashRed: {
          "0%": { backgroundColor: "rgba(255,61,90,0.2)" },
          "100%": { backgroundColor: "transparent" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
