import { useMemo } from 'react';

interface DiffViewerProps {
  diff: string;
}

interface DiffLine {
  type: 'header' | 'hunk' | 'add' | 'remove' | 'context' | 'meta';
  content: string;
}

function parseDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      lines.push({ type: 'header', content: raw });
    } else if (raw.startsWith('@@')) {
      lines.push({ type: 'hunk', content: raw });
    } else if (raw.startsWith('+')) {
      lines.push({ type: 'add', content: raw });
    } else if (raw.startsWith('-')) {
      lines.push({ type: 'remove', content: raw });
    } else if (raw.startsWith('commit ') || raw.startsWith('Author:') || raw.startsWith('Date:')) {
      lines.push({ type: 'meta', content: raw });
    } else {
      lines.push({ type: 'context', content: raw });
    }
  }
  return lines;
}

export function DiffViewer({ diff }: DiffViewerProps) {
  const lines = useMemo(() => parseDiff(diff), [diff]);

  if (!diff.trim()) {
    return <div className="diff-empty">No changes recorded.</div>;
  }

  return (
    <div className="diff-viewer">
      {lines.map((line, i) => (
        <div key={i} className={`diff-line diff-line-${line.type}`}>
          <span className="diff-line-content">{line.content || '\u00a0'}</span>
        </div>
      ))}
    </div>
  );
}
