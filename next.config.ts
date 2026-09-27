import type { NextConfig } from 'next';
import path from 'path';
import { nextHtmlAppCacheHeaders } from './src/lib/page-cache';

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname),
  },
  // Allow Replit / preview hosts
  allowedDevOrigins: [
    '**.replit.dev',
    '**.repl.co',
  ],
  agentRules: false,
  async headers() {
    return nextHtmlAppCacheHeaders();
  },
};

export default nextConfig;
