import type { StopMode } from '@shared/types';

interface StopModePickerProps {
  mode: StopMode;
  value: number | null;
  onModeChange: (mode: StopMode) => void;
  onValueChange: (value: number | null) => void;
  label?: string;
}

const MODES: { key: StopMode; label: string }[] = [
  { key: 'turns', label: 'Turns' },
  { key: 'budget', label: 'Budget' },
  { key: 'time', label: 'Time' },
  { key: 'completion', label: 'Run to Completion' },
];

export function StopModePicker({ mode, value, onModeChange, onValueChange, label }: StopModePickerProps) {
  return (
    <div className="form-group">
      {label && <label>{label}</label>}
      <div className="stop-mode-buttons">
        {MODES.map(m => (
          <button
            key={m.key}
            type="button"
            className={`stop-mode-btn${mode === m.key ? ' active' : ''}`}
            onClick={() => {
              onModeChange(m.key);
              if (m.key === 'completion') onValueChange(null);
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="stop-mode-input">
        {mode === 'turns' && (
          <input
            type="number"
            min={10}
            max={500}
            value={value ?? ''}
            onChange={e => onValueChange(Number(e.target.value))}
            placeholder="50"
          />
        )}
        {mode === 'budget' && (
          <div className="stop-mode-prefixed-input">
            <span className="stop-mode-prefix">$</span>
            <input
              type="number"
              min={0.5}
              max={500}
              step={0.5}
              value={value ?? ''}
              onChange={e => onValueChange(Number(e.target.value))}
              placeholder="5.00"
            />
          </div>
        )}
        {mode === 'time' && (
          <div className="stop-mode-prefixed-input">
            <input
              type="number"
              min={5}
              max={480}
              value={value ?? ''}
              onChange={e => onValueChange(Number(e.target.value))}
              placeholder="60"
            />
            <span className="stop-mode-suffix">min</span>
          </div>
        )}
        {mode === 'completion' && (
          <span className="stop-mode-hint">Runs until done (safety cap: 1000 turns)</span>
        )}
      </div>
    </div>
  );
}
