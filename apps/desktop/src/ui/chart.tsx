import { useLayoutEffect, useRef, useState } from "react";

export interface Series {
  name: string;
  /** The series that matters, in the accent; the other is compared with it, in muted. */
  key: boolean;
}

export interface Group {
  /** The axis label: TUE. */
  label: string;
  /** The tooltip's heading: Tue 24 Nov. */
  title: string;
  values: number[];
}

const HEIGHT = 160;
const AXIS = 20;
const LEFT = 44;
const GAP = 2;

/** Round steps for the grid: 1, 2 or 5 times a power of ten, three or four lines. */
function ticks(max: number): number[] {
  if (max <= 0) return [0];
  const rough = max / 3;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 5, 10].find((factor) => factor * power >= rough) ?? 10) * power;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, index) => index * step);
}

/**
 * Bars in neon on ink (components/stat-and-chart.md#chart-anatomy): horizontal grid lines at round values, the axis
 * in mono, the key series in the accent, a legend above when there are two. Drawn at the size it is shown.
 */
export function BarChart({
  label,
  series,
  groups,
  format,
}: {
  /** What it shows, for screen readers: the numbers in words. */
  label: string;
  series: Series[];
  groups: Group[];
  format: (value: number) => string;
}) {
  const box = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(240, Math.round(entry?.contentRect.width ?? 640))),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const max = Math.max(0, ...groups.flatMap((group) => group.values));
  const steps = ticks(max);
  const top = steps.at(-1) || 1;
  const y = (value: number) => 6 + (HEIGHT - 6) * (1 - value / top);
  const slot = (width - LEFT) / Math.max(groups.length, 1);
  const bar = Math.max(2, Math.min(24, (slot * 0.6 - GAP * (series.length - 1)) / series.length));

  return (
    <figure ref={box} className="chart">
      {series.length > 1 && (
        <figcaption className="chart-legend">
          {series.map((entry) => (
            <span key={entry.name}>
              <i className={entry.key ? "chart-swatch-key" : "chart-swatch-compare"} />
              {entry.name}
            </span>
          ))}
        </figcaption>
      )}
      {max === 0 ? (
        <p className="grid place-items-center text-sm text-muted" style={{ height: HEIGHT + AXIS }}>
          Nothing spent in these days.
        </p>
      ) : (
        <svg viewBox={`0 0 ${width} ${HEIGHT + AXIS}`} role="img" aria-label={label}>
          <g className="chart-grid">
            {steps.map((value) => (
              <line key={value} x1={LEFT} x2={width} y1={y(value)} y2={y(value)} />
            ))}
          </g>
          <g className="chart-axis">
            {steps.map((value) => (
              <text key={value} x={0} y={y(value) + 4}>
                {format(value)}
              </text>
            ))}
            {groups.map((group, index) => (
              <text key={group.title} x={LEFT + slot * (index + 0.5)} y={HEIGHT + AXIS - 4} textAnchor="middle">
                {group.label}
              </text>
            ))}
          </g>
          {groups.map((group, index) => {
            const start = LEFT + slot * (index + 0.5) - (bar * series.length + GAP * (series.length - 1)) / 2;
            const said = [group.title, ...series.map((entry, n) => `${entry.name} ${format(group.values[n] ?? 0)}`)];
            return (
              <g key={group.title}>
                <rect
                  className="chart-hover"
                  x={LEFT + slot * index}
                  y={0}
                  width={slot}
                  height={HEIGHT}
                  data-tip={said.join(" · ")}
                />
                {series.map((entry, n) => {
                  const value = group.values[n] ?? 0;
                  return (
                    <rect
                      key={entry.name}
                      className={entry.key ? "chart-bar-key" : "chart-bar-compare"}
                      pointerEvents="none"
                      x={start + n * (bar + GAP)}
                      y={y(value)}
                      width={bar}
                      height={Math.max(0, y(0) - y(value))}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
      )}
    </figure>
  );
}
