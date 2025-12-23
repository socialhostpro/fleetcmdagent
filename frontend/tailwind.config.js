/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Backgrounds
        'bg-primary': '#0a0a0f',
        'bg-secondary': '#12121a',
        'bg-tertiary': '#1a1a24',
        'bg-hover': '#22222e',

        // Borders
        'border-subtle': '#2a2a3a',
        'border-default': '#3a3a4a',
        'border-bright': '#4a4a5a',

        // Text
        'text-primary': '#ffffff',
        'text-secondary': '#a0a0b0',
        'text-muted': '#606070',
        'text-accent': '#00d4ff',

        // Status colors
        'status-online': '#00ff88',
        'status-warning': '#ffaa00',
        'status-error': '#ff4444',
        'status-offline': '#666666',
        'status-busy': '#00aaff',

        // Cluster colors
        'cluster-spark': '#76b900',
        'cluster-vision': '#ff6b6b',
        'cluster-media-gen': '#9b59b6',
        'cluster-media-proc': '#3498db',
        'cluster-llm': '#f39c12',
        'cluster-voice': '#1abc9c',
        'cluster-music': '#e91e63',
        'cluster-agentic': '#7c3aed',
        'cluster-roamer': '#95a5a6',
        'cluster-inference': '#00bcd4',
        'cluster-unassigned': '#616161',

        // Traffic animation
        'traffic-data': '#00d4ff',
        'traffic-control': '#ff00ff',
        'traffic-backup': '#ffff00',
      },
      boxShadow: {
        'glow-green': '0 0 20px rgba(118, 185, 0, 0.3)',
        'glow-cyan': '0 0 20px rgba(0, 212, 255, 0.3)',
        'glow-online': '0 0 10px rgba(0, 255, 136, 0.4)',
        'glow-error': '0 0 10px rgba(255, 68, 68, 0.4)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'flow': 'flow 2s linear infinite',
        'glow': 'glow 2s ease-in-out infinite alternate',
      },
      keyframes: {
        flow: {
          '0%': { strokeDashoffset: '24' },
          '100%': { strokeDashoffset: '0' },
        },
        glow: {
          '0%': { boxShadow: '0 0 5px rgba(0, 212, 255, 0.2)' },
          '100%': { boxShadow: '0 0 20px rgba(0, 212, 255, 0.6)' },
        },
      },
    },
  },
  plugins: [],
}
