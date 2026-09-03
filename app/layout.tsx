import type { ReactNode } from 'react'

export const metadata = {
  title: 'Pujara & Co. — Task Tracker',
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
