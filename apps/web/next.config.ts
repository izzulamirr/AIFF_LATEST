import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Document uploads (P&IDs, ISOs, line lists) go through a server
      // action; the framework default of 1 MB rejects real drawing PDFs.
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
