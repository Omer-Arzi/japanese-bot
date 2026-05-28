export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        jp: {
          bg:            "#faf8f5",
          surface:       "#ede9e4",
          "surface-2":   "#e5e0da",
          border:        "#d0c9c0",
          text:          "#1c1814",
          muted:         "#6b6056",
          faint:         "#9c8f86",
          accent:        "#b03030",
          "accent-hover":"#952828",
        },
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};
