/** @type {import('next').NextConfig} */
const nextConfig = {
  // Dev-only: lets other devices on the office LAN (phone/laptop via
  // http://192.168.x.x:3000) load dev assets without the cross-origin
  // warning. Ignored in production builds, so it has no effect on Vercel.
  allowedDevOrigins: ['192.168.1.11', '192.168.1.*', '172.27.224.1', '172.27.*'],
  typescript: {
    ignoreBuildErrors: false,
  },
  async rewrites() {
    return [
      // Pretty URL for the staff tracker — serves /tracker.html as /tracker
      { source: '/tracker', destination: '/tracker.html' },
    ]
  },
}

export default nextConfig
