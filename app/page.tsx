import { redirect } from 'next/navigation'

/* The tracker UI is the static /tracker.html; the root of this app just goes there. */
export default function Home() {
  redirect('/tracker')
}
