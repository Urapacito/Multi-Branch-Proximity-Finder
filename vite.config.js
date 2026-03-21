import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    minify: 'terser', // Switch from esbuild to Terser
    terserOptions: {
      mangle: {
        toplevel: true, // This is the "secret sauce" that renames your main functions
      },
      compress: {
        drop_console: true, // Removes console.logs for extra protection
        drop_debugger: true,
      },
    },
    // This ensures your assets like the heart icon and CSS are handled
    assetsDir: 'assets', 
  },
});