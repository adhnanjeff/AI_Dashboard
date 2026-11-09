'use client';

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="card empty" role="alert">
      <p><strong>Something went wrong in the dashboard.</strong></p>
      <p className="muted">{error.message}</p>
      <button className="btn" onClick={reset}>Try again</button>
    </div>
  );
}
