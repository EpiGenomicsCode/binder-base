import { useRef } from "react";

interface Props {
  value: string;
  onChange: (q: string) => void;
  onSubmit?: (q: string) => void;
  examples?: string[];
  compact?: boolean;
}

export default function ProteinSearchBar({ value, onChange, onSubmit, examples, compact }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && onSubmit) {
      onSubmit(value.trim());
    }
  }

  if (compact) {
    return (
      <div className="search-bar-compact">
        <input
          ref={inputRef}
          className="hero-search-input"
          type="search"
          placeholder="Search proteins…"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
    );
  }

  return (
    <>
      <div className="hero-search-wrap">
        <input
          ref={inputRef}
          className="hero-search-input"
          type="search"
          placeholder="Search proteins…"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
      </div>
      {examples && examples.length > 0 && (
        <div className="hero-examples">
          <span className="hero-examples-label">Try:</span>
          {examples.map((ex) => (
            <button
              key={ex}
              className="pill-btn hero-example-chip"
              onClick={() => {
                onChange(ex);
                inputRef.current?.focus();
              }}
            >
              {ex}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
