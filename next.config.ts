import type { NextConfig } from 'next';
import path from 'path';

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
};

export default nextConfig;
