# Viewport Capture

A minimal Manifest V3 Chrome extension that adds `Capture` to the page context
menu. It captures the visible browser viewport repeatedly, restores the original
scroll position, and downloads a ZIP containing only numbered PNG files.

## Build

```sh
npm install
npm run typecheck
npm run build
```

Load the generated `dist/` folder from `chrome://extensions` with Developer mode
enabled.
