export default {
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5199,
    strictPort: true,
    // Test and capture runs set NO_HMR, because a hot reload pushed by an
    // unrelated file save destroys the page mid-measurement.
    hmr: process.env.NO_HMR ? false : undefined
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, assetsInlineLimit: 0 }
};
