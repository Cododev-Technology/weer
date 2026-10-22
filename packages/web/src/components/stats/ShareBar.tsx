import React, { FC } from "react";
import { formatNumber, formatPercent } from "../../lib/stats";

export interface ShareBarPart {
  key: string;
  label: string;
  icon: string; // a Font Awesome class
  value: number;
  // The series of the chart palette: 1 blue, 2 orange, 3 aqua (see _link-stats.scss)
  series: 1 | 2 | 3;
}

interface ShareBarProps {
  label: string;
  parts: ShareBarPart[];
}

// One bar split into the share of each part, with a legend that has the numbers
const ShareBar: FC<ShareBarProps> = ({ label, parts }) => {
  const total = parts.reduce((sum, part) => sum + part.value, 0);

  return (
    <div className="share-bar">
      <div className="share-bar__label">{label}</div>

      <div
        className={"share-bar__track" + (total > 0 ? "" : " share-bar__track--empty")}
        role="img"
        aria-label={label}
      >
        {total > 0 &&
          parts
            .filter((part) => part.value > 0)
            .map((part) => (
              <span
                key={part.key}
                className={`share-bar__part share-bar__part--${part.series}`}
                style={{ flexGrow: part.value }}
                title={`${part.label}: ${formatNumber(part.value)} (${formatPercent(part.value, total)})`}
              />
            ))}
      </div>

      <ul className="share-bar__legend">
        {parts.map((part) => (
          <li className="share-bar__legend-item" key={part.key}>
            <span className={`share-bar__swatch share-bar__part--${part.series}`} aria-hidden="true" />
            <i className={`share-bar__icon ${part.icon}`} aria-hidden="true" />
            <span className="share-bar__name">{part.label}</span>
            <span className="share-bar__value">{formatNumber(part.value)}</span>
            <span className="share-bar__percent">{formatPercent(part.value, total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default ShareBar;
