/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    dirs: ["app", "lib", "components"],
  },
};

export default nextConfig;
