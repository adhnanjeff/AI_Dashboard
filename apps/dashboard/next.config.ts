import type { NextConfig } from 'next';

const config: NextConfig = {
  // Compression buffers responses, which would stall the live event stream (SSE).
  compress: false,
  poweredByHeader: false,
};
export default config;
