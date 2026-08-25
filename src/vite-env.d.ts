// Ambient type declarations for Vite-handled asset imports (e.g. `import
// "./x.css"`). TypeScript's own module resolution has no idea what a .css
// file is - vite/client declares wildcard modules (`*.css`, `*.svg`, etc.)
// so side-effect imports of them type-check instead of failing with
// "Cannot find module or type declarations for side-effect import".
// Standard Vite project convention; every default `create-vite` scaffold
// ships this same file for this same reason.
/// <reference types="vite/client" />
