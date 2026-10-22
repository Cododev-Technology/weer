import React, { FC, useEffect, useRef, useState } from "react";
import type { API } from "@weer/common";
import { axisLabel, barLabel, formatNumber } from "../../lib/stats";

interface ClicksChartProps {
  timeline: API.Url.Analytics["timeline"];
  interval: API.Url.Analytics["interval"];
}

// The sizes of the chart, in pixels
const PLOT_HEIGHT = 180;
const TOP = 20; // room for the label of the highest bar
const AXIS_HEIGHT = 26;
const LEFT = 36; // room for the numbers of the y axis
const MAX_BAR_WIDTH = 24;
const BAR_RADIUS = 4;
const MIN_LABEL_SPACE = 64;

// The step between the lines of the y axis: 1, 2 or 5 times a power of 10, for about 4 lines
const tickStep = (max: number): number => {
  const raw = Math.max(max / 4, 1);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const n = raw / magnitude;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * magnitude;
};

// A bar with a rounded top, square at the bottom
const barPath = (x: number, y: number, width: number, height: number): string => {
  const r = Math.min(BAR_RADIUS, width / 2, height);
  const bottom = y + height;
  return (
    `M${x},${bottom} L${x},${y + r} A${r},${r} 0 0 1 ${x + r},${y} ` +
    `L${x + width - r},${y} A${r},${r} 0 0 1 ${x + width},${y + r} L${x + width},${bottom} Z`
  );
};

const ClicksChart: FC<ClicksChartProps> = ({ timeline, interval }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(0);
  const [active, setActive] = useState<number | null>(null);

  // The chart takes the width of its card
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    setWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const count = timeline.length;
  const max = Math.max(0, ...timeline.map((bar) => bar.clicks));
  const step = tickStep(max);
  const top = Math.max(step, Math.ceil(max / step) * step);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);

  const plotWidth = Math.max(0, width - LEFT);
  const band = count ? plotWidth / count : 0;
  const barWidth = Math.max(1, Math.min(MAX_BAR_WIDTH, band * 0.72, band - 2));
  const y = (value: number) => TOP + PLOT_HEIGHT - (value / top) * PLOT_HEIGHT;

  // A label under every few bars, so they don't run into each other
  const labelEvery = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(plotWidth / MIN_LABEL_SPACE))));
  const peak = max > 0 ? timeline.findIndex((bar) => bar.clicks === max) : -1;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const current = active ?? count - 1;
    setActive(Math.min(count - 1, Math.max(0, current + (e.key === "ArrowLeft" ? -1 : 1))));
  };

  const activeBar = active !== null ? timeline[active] : null;
  const tooltipLeft =
    active !== null ? Math.min(Math.max(LEFT + band * (active + 0.5), 70), width - 70) : 0;

  return (
    <div className="clicks-chart" ref={containerRef}>
      {width > 0 && (
        <svg
          className="clicks-chart__svg"
          width={width}
          height={TOP + PLOT_HEIGHT + AXIS_HEIGHT}
          role="img"
          aria-label={`Clicks over time: ${formatNumber(
            timeline.reduce((sum, bar) => sum + bar.clicks, 0)
          )} in total. Use the arrow keys to read each bar.`}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={() => setActive((current) => current ?? count - 1)}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                className="clicks-chart__grid"
                x1={LEFT}
                x2={width}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text className="clicks-chart__tick" x={LEFT - 8} y={y(tick)} dy="0.35em" textAnchor="end">
                {formatNumber(tick)}
              </text>
            </g>
          ))}

          {timeline.map((bar, i) => {
            const x = LEFT + band * i + (band - barWidth) / 2;
            const height = (bar.clicks / top) * PLOT_HEIGHT;

            return (
              <g key={bar.start}>
                {bar.clicks > 0 && (
                  <path
                    className={
                      "clicks-chart__bar" + (active === i ? " clicks-chart__bar--active" : "")
                    }
                    d={barPath(x, y(bar.clicks), barWidth, height)}
                  />
                )}

                {i === peak && (
                  <text
                    className="clicks-chart__peak"
                    x={x + barWidth / 2}
                    y={y(bar.clicks) - 6}
                    textAnchor="middle"
                  >
                    {formatNumber(bar.clicks)}
                  </text>
                )}

                {i % labelEvery === 0 && (
                  <text
                    className="clicks-chart__tick"
                    x={LEFT + band * (i + 0.5)}
                    y={TOP + PLOT_HEIGHT + 18}
                    textAnchor="middle"
                  >
                    {axisLabel(bar.start, interval)}
                  </text>
                )}

                {/* The whole column is the target, not only the bar */}
                <rect
                  className="clicks-chart__hit"
                  x={LEFT + band * i}
                  y={TOP}
                  width={band}
                  height={PLOT_HEIGHT}
                  onPointerEnter={() => setActive(i)}
                  onPointerMove={() => setActive(i)}
                />
              </g>
            );
          })}
        </svg>
      )}

      {max === 0 && (
        <div className="clicks-chart__empty">No clicks in this time range yet.</div>
      )}

      {activeBar && (
        <div className="clicks-chart__tooltip" style={{ left: tooltipLeft }}>
          <strong>
            {formatNumber(activeBar.clicks)} {activeBar.clicks === 1 ? "click" : "clicks"}
          </strong>
          <span>{barLabel(activeBar.start, interval)}</span>
        </div>
      )}

      {/* The same numbers for screen readers */}
      <table className="u-visually-hidden">
        <caption>Clicks over time</caption>
        <tbody>
          {timeline.map((bar) => (
            <tr key={bar.start}>
              <th scope="row">{barLabel(bar.start, interval)}</th>
              <td>{bar.clicks}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default ClicksChart;
