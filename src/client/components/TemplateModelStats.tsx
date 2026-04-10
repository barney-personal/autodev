import { useState, useEffect } from 'react';
import type { TemplateModelStat } from '@shared/types';

interface TemplateModelStatsProps {
  templateId: string;
  model: string;
}

export function TemplateModelStats({ templateId, model }: TemplateModelStatsProps) {
  const [stats, setStats] = useState<TemplateModelStat[]>([]);

  useEffect(() => {
    fetch('/api/stats/template-model')
      .then(r => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  // Find matching stat for current template+model combo
  const match = stats.find(s => {
    const templateMatch = templateId ? s.template_id === templateId : s.template_id == null;
    const modelMatch = model ? s.model === model : s.model == null;
    return templateMatch && modelMatch;
  });

  if (!match || match.total < 1) return null;

  const rate = Math.round((match.success_rate ?? 0) * 100);
  const costStr = match.avg_cost != null ? `$${match.avg_cost.toFixed(3)}` : '—';
  const turnsStr = match.avg_turns != null ? Math.round(match.avg_turns).toString() : '—';
  // const modelLabel = match.model?.replace('claude-', '') ?? 'auto';

  return (
    <div className="template-model-stats" title={`Based on ${match.total} runs`}>
      <span className={`stat-rate ${rate >= 80 ? 'stat-good' : rate >= 50 ? 'stat-ok' : 'stat-bad'}`}>
        {rate}% success
      </span>
      <span className="stat-detail">({match.total} runs, avg {costStr}, {turnsStr} turns)</span>
    </div>
  );
}
