import { defineConfig } from "vite";

// Relative paths, so the built report opens from any directory or Pages path.
// Graphviz's WASM module is one lazy chunk of about 1.4 MB, loaded with the first process map.
export default defineConfig({ base: "./", build: { chunkSizeWarningLimit: 1500 } });
