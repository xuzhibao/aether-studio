/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#1D1D1F",
        canvas: "#F5F6F8",
        panel: "#FFFFFF",
        line: "#E6E8EC",
      },
      fontFamily: {
        sans: ["Inter Variable", "Inter", "-apple-system", "BlinkMacSystemFont", "SF Pro Text", "Helvetica Neue", "sans-serif"],
        mono: ["JetBrains Mono Variable", "JetBrains Mono", "SF Mono", "Menlo", "monospace"],
      },
      boxShadow: {
        float: "0 0 0 0.5px rgba(20,24,33,0.06), 0 2px 6px rgba(20,24,33,0.05), 0 16px 40px -16px rgba(20,24,33,0.18)",
        panel: "0 0 0 0.5px rgba(20,24,33,0.05), 0 1px 3px rgba(20,24,33,0.05)",
        pop: "0 0 0 0.5px rgba(20,24,33,0.09), 0 8px 24px -8px rgba(20,24,33,0.18), 0 2px 6px rgba(20,24,33,0.05)",
      },
      borderRadius: {
        "4xl": "22px",
      },
    },
  },
  plugins: [],
};
