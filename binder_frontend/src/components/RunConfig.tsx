import { Fragment, useState } from "react";
import type { BinderRun } from "../types";

export function runLabel(run: BinderRun): string {
  if (run.description) return run.description;
  const parts = [run.algorithm, run.run_datetime ? new Date(run.run_datetime).toLocaleDateString() : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" — ") : `Run #${run.id}`;
}

interface RunStep {
  name: string;
  config: unknown;
  configPath: string | null;
}

export function normalizeSteps(stepsConfig: unknown): RunStep[] {
  if (!stepsConfig) return [];

  const pickConfig = (val: Record<string, unknown>): unknown => {
    if ("config" in val) return val.config;
    if ("config_file" in val) return val.config_file;
    if ("config_path" in val) return val.config_path;
    return null;
  };

  const pickConfigPath = (val: Record<string, unknown>): string | null => {
    for (const k of ["config_path", "config_file_path", "config_file"] as const) {
      const v = val[k];
      if (typeof v === "string") return v;
    }
    // Older format where config field itself was the path string
    if (typeof val.config === "string") return val.config;
    return null;
  };

  const fromEntry = (entry: unknown, idx: number): RunStep => {
    if (typeof entry === "string") return { name: entry, config: null, configPath: null };
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      const name = e.name ?? e.step ?? e.id ?? `Step ${idx + 1}`;
      const config = pickConfig(e);
      const configPath = pickConfigPath(e);
      return {
        name: String(name),
        config: typeof config === "string" ? null : config,
        configPath,
      };
    }
    return { name: `Step ${idx + 1}`, config: null, configPath: null };
  };

  let rawList: unknown[] | null = null;

  if (Array.isArray(stepsConfig)) {
    rawList = stepsConfig;
  } else if (typeof stepsConfig === "object") {
    const obj = stepsConfig as Record<string, unknown>;
    if (Array.isArray(obj.steps)) {
      rawList = obj.steps;
    } else if (obj.steps && typeof obj.steps === "object") {
      return Object.entries(obj.steps as Record<string, unknown>).map(([k, v]) => ({
        name: k,
        config: v && typeof v === "object" ? pickConfig(v as Record<string, unknown>) : v,
        configPath: v && typeof v === "object" ? pickConfigPath(v as Record<string, unknown>) : null,
      }));
    } else {
      return Object.entries(obj).map(([k, v]) => ({
        name: k,
        config: v && typeof v === "object" ? pickConfig(v as Record<string, unknown>) : v,
        configPath: v && typeof v === "object" ? pickConfigPath(v as Record<string, unknown>) : null,
      }));
    }
  }

  return rawList ? rawList.map(fromEntry) : [];
}

// A one-line preview for the collapsed "Steps & Configuration" header, so the
// section advertises its contents rather than hiding them behind a bare title.
export function configSummary(run: BinderRun): string {
  const parts: string[] = [];
  const steps = normalizeSteps(run.steps_config).length;
  if (steps) parts.push(`${steps} step${steps === 1 ? "" : "s"}`);
  // `metadata` is typed `unknown`; narrow through a local so the check holds.
  const meta: unknown = run.metadata;
  const metaCount =
    meta !== null && typeof meta === "object" && !Array.isArray(meta)
      ? Object.keys(meta).length
      : 0;
  const fields =
    metaCount +
    [run.algorithm, run.run_datetime, run.hardware, run.description, run.notes].filter(
      Boolean
    ).length;
  if (fields) parts.push(`${fields} field${fields === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

export function RunStepsList({ stepsConfig }: { stepsConfig: unknown }) {
  const steps = normalizeSteps(stepsConfig);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  if (steps.length === 0) return null;

  function toggle(i: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }

  return (
    <div className="run-steps-section">
      <div className="run-steps-section-title">Steps</div>
      <ol className="run-steps-list">
        {steps.map((step, i) => {
          const isOpen = expanded.has(i);
          const hasConfig = step.config !== null && step.config !== undefined;
          return (
            <li key={i} className="run-step-item">
              <div className="run-step-header">
                <span className="run-step-name">{step.name}</span>
                {hasConfig && (
                  <button
                    className="run-step-toggle"
                    onClick={() => toggle(i)}
                    aria-expanded={isOpen}
                  >
                    {isOpen ? "Hide config ▲" : "Show config ▼"}
                  </button>
                )}
              </div>
              {isOpen && hasConfig && (
                <pre className="run-step-config">
                  {JSON.stringify(step.config, null, 2)}
                </pre>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}


// The leftover meta.json keys, rendered as extra rows of the run's key/value
// list alongside Algorithm, Run date and the rest — those three were lifted out
// of the same file at import time, so they belong in one list.
//
// Returns a Fragment rather than a wrapper element: `run-config-dl` is a grid,
// so the <dt>/<dd> pairs have to stay direct children of the <dl> to line up.
export function RunMetadata({ metadata }: { metadata: unknown }) {
  if (metadata === null || metadata === undefined) return null;

  // A non-object value (array, string, number) has no keys to merge into the
  // list, so it gets a single row under a generic label.
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    return (
      <>
        <dt>Metadata</dt>
        <dd>
          <pre className="run-step-config">{JSON.stringify(metadata, null, 2)}</pre>
        </dd>
      </>
    );
  }

  const entries = Object.entries(metadata as Record<string, unknown>);
  if (entries.length === 0) return null;

  return (
    <>
      {entries.map(([key, val]) => (
        <Fragment key={key}>
          <dt>{key}</dt>
          <dd>
            {val !== null && typeof val === "object" ? (
              <pre className="run-step-config">{JSON.stringify(val, null, 2)}</pre>
            ) : (
              String(val)
            )}
          </dd>
        </Fragment>
      ))}
    </>
  );
}

