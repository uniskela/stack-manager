/** Renders structured unified-diff hunks with the shared `.diff` visual language. */
export function UnifiedDiff({
  hunks,
  label = 'Line changes',
}: {
  hunks: Array<{
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  }>;
  label?: string;
}) {
  if (hunks.length === 0) return <p className="fine-print change-head">No textual changes.</p>;
  return (
    <div className="diff" role="table" aria-label={label}>
      {hunks.map((hunk, h) => {
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        return (
          <div key={h} role="rowgroup">
            <div className="diff-hunk" role="row">
              <span role="cell">
                @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
              </span>
            </div>
            {hunk.lines.map((line, i) => {
              const sign = line[0];
              if (sign === '\\') return null;
              const kind = sign === '+' ? 'add' : sign === '-' ? 'remove' : 'same';
              const oldNo = kind === 'add' ? '' : oldLine++;
              const newNo = kind === 'remove' ? '' : newLine++;
              return (
                <div key={i} className={`diff-line ${kind}`} role="row">
                  <span className="ln" role="cell">
                    {oldNo}
                  </span>
                  <span className="ln" role="cell">
                    {newNo}
                  </span>
                  <span
                    className="sign"
                    role="cell"
                    aria-label={kind === 'same' ? undefined : kind === 'add' ? 'added' : 'removed'}
                  >
                    {kind === 'same' ? ' ' : sign}
                  </span>
                  <span role="cell">{line.slice(1)}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
