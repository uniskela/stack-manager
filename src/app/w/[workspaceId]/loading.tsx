/** Skeleton shown inside the shell while a workspace page loads on the server. */
export default function WorkspaceLoading() {
  return (
    <div className="stack" aria-busy="true">
      <span className="visually-hidden" role="status">
        Loading…
      </span>
      <div className="page-head">
        <span className="skeleton title" />
        <span className="skeleton line page-desc" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="card stack" aria-hidden="true">
          <span className="skeleton line" />
          <span className="skeleton line" />
        </div>
      ))}
    </div>
  );
}
