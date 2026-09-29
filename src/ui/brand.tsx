export function Brand({ href = '/' }: { href?: string }) {
  return (
    <a className="brand" href={href}>
      <span className="brand-mark" aria-hidden="true" />
      <span className="brand-text">stack-manager</span>
    </a>
  );
}
