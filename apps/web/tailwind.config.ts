import type { Config } from "tailwindcss";

const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: { sans: ["var(--font-sans)", "ui-sans-serif", "system-ui"], mono: ["var(--font-mono)", "ui-monospace", "monospace"] },
      colors: {
        bg: v("bg"), panel: v("panel"), raised: v("raised"), line: v("line"), fg: v("fg"), muted: v("muted"), subtle: v("subtle"),
        accent: v("accent"), ok: v("ok"), warn: v("warn"), bad: v("bad"), info: v("info"),
      },
      boxShadow: { glow: "0 0 0 1px rgb(var(--accent) / 0.35), 0 8px 30px -12px rgb(var(--accent) / 0.45)" },
      keyframes: { pulseRing: { "0%": { transform: "scale(.8)", opacity: ".8" }, "100%": { transform: "scale(2.2)", opacity: "0" } }, fadeIn: { from: { opacity: "0", transform: "translateY(4px)" }, to: { opacity: "1", transform: "none" } } },
      animation: { pulseRing: "pulseRing 1.6s cubic-bezier(.2,.6,.4,1) infinite", fadeIn: "fadeIn .25s ease-out both" },
    },
  },
  plugins: [],
} satisfies Config;
