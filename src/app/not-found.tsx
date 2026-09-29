import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="center-shell">
      <div className="auth-card card">
        <h1>Not found</h1>
        <p className="muted">That page does not exist, or you do not have access to it.</p>
        <Link className="btn" href="/">
          Go home
        </Link>
      </div>
    </main>
  );
}
