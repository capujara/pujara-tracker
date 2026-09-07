/** @type {import('next').NextConfig} */
const nextConfig = {
  // Dev-only: lets other devices on the office LAN (phone/laptop via
  // http://192.168.x.x:3000) load dev assets without the cross-origin
  // warning. Ignored in production builds, so it has no effect on Vercel.
  allowedDevOrigins: ['192.168.1.11', '192.168.1.*', '172.27.224.1', '172.27.*'],
  typescript: {
    ignoreBuildErrors: false,
  },
  async headers() {
    return [
      // The tracker is an internal staff tool - never index it. The
      // robots metadata in app/layout.tsx only covers Next routes; /tracker
      // is a static file (public/tracker.html) served via the rewrite below,
      // so it needs a response header instead. Applies to every path.
      {
        source: '/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
    ]
  },
  async rewrites() {
    return [
      // Pretty URL for the staff tracker — serves /tracker.html as /tracker
      { source: '/tracker', destination: '/tracker.html' },
    ]
  },
}

export default nextConfig
