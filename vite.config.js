import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

const hbsLoader = {
  name: 'hbs-loader',
  resolveId(id) {
    if (id.endsWith('.hbs')) {
      return id;
    }
  },
  async load(id) {
    if (id.endsWith('.hbs')) {
      const filePath = path.resolve(id);
      const content = fs.readFileSync(filePath, 'utf-8');
      return `import Handlebars from 'handlebars';
const template = Handlebars.compile(${JSON.stringify(content)});
export default function(context) {
  return template(context || {});
}`;
    }
  }
};

const setupWasm = {
  name: 'setup-wasm',
  apply: 'serve',
  enforce: 'pre',
  configResolved() {
    // Copy web-ifc WASM file to public directory once (only if needed)
    const wasmSrc = path.resolve('./node_modules/web-ifc/web-ifc.wasm');
    const wasmDest = path.resolve('./public/web-ifc.wasm');

    if (!fs.existsSync('./public')) {
      fs.mkdirSync('./public', { recursive: true });
    }

    // Only copy if destination doesn't exist or source is newer
    let shouldCopy = false;
    if (!fs.existsSync(wasmDest)) {
      shouldCopy = true;
    } else {
      const srcStats = fs.statSync(wasmSrc);
      const destStats = fs.statSync(wasmDest);
      if (srcStats.mtime > destStats.mtime) {
        shouldCopy = true;
      }
    }

    if (shouldCopy && fs.existsSync(wasmSrc)) {
      fs.copyFileSync(wasmSrc, wasmDest);
    }
  }
};

export default defineConfig({
  plugins: [hbsLoader, setupWasm],
  publicDir: 'public',
  server: {
    port: 5001,
    host: 'localhost',
    proxy: {
      '/api': {
        target: 'http://localhost:5002',
        changeOrigin: true,
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: undefined
      }
    }
  },
  optimizeDeps: {
    exclude: ['web-ifc']
  }
});
