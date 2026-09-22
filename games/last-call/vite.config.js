export default {
  base: './',
  server: { host: '0.0.0.0', port: 5199, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, assetsInlineLimit: 0 }
};
