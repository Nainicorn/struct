import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

const hbsLoader = {
  name: 'hbs-loader',
  resolveId(id) {
    if (id.endsWith('.hbs')) {
      return { id, moduleSideEffects: false };
    }
  },
  load(id) {
    if (id.endsWith('.hbs')) {
      const content = fs.readFileSync(id, 'utf-8');
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
    // Copy web-ifc WASM files to public directory once (only if needed)
    if (!fs.existsSync('./public')) {
      fs.mkdirSync('./public', { recursive: true });
    }

    const wasmFiles = ['web-ifc.wasm', 'web-ifc-mt.wasm', 'web-ifc-mt.worker.js', 'web-ifc-api.js'];
    for (const wasmFile of wasmFiles) {
      const wasmSrc = path.resolve(`./node_modules/web-ifc/${wasmFile}`);
      const wasmDest = path.resolve(`./public/${wasmFile}`);

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

        // Patch web-ifc-mt.worker.js: when urlOrBlob is undefined (ES module context),
        // fall back to deriving the web-ifc-api.js URL from the worker's own location.
        if (wasmFile === 'web-ifc-mt.worker.js') {
          let workerSrc = fs.readFileSync(wasmDest, 'utf-8');
          workerSrc = workerSrc.replace(
            '}else{var objectUrl=URL.createObjectURL(e.data.urlOrBlob);importScripts(objectUrl);URL.revokeObjectURL(objectUrl)}',
            '}else if(e.data.urlOrBlob!=null){var objectUrl=URL.createObjectURL(e.data.urlOrBlob);importScripts(objectUrl);URL.revokeObjectURL(objectUrl)}else{importScripts(self.location.href.replace(/web-ifc-mt\\.worker\\.js$/,"web-ifc-api.js"))}'
          );
          fs.writeFileSync(wasmDest, workerSrc, 'utf-8');
        }
      }
    }
  }
};

export default defineConfig({
  plugins: [hbsLoader, setupWasm],
  root: './',
  publicDir: 'public',
  server: {
    port: 5001,
    host: 'localhost',
    headers(req) {
      // Prevent browser from caching the patched web-ifc worker
      if (req && (req.url || '').includes('web-ifc-mt.worker.js')) {
        return { 'Cache-Control': 'no-store' };
      }
      return {};
    },
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
  resolve: {
    alias: {
      '@ui': path.resolve(__dirname, 'ui')
    }
  },
  optimizeDeps: {
    exclude: ['web-ifc']
  }
});
