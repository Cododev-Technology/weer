import React, { FC } from "react";
import { formatNumber, formatPercent } from "../../lib/stats";

export interface TopListItem {
  key: string;
  label: string;
  // An emoji (like a flag) or a Font Awesome class
  icon?: { emoji?: string; className?: string };
  value: number;
}

interface TopListProps {
  title: string;
  items: TopListItem[];
  // What the percentages are of
  total: number;
  footer?: React.ReactNode;
}

// A list of the top items, each with a bar as long as its share of the first one
const TopList: FC<TopListProps> = ({ title, items, total, footer }) => {
  const max = Math.max(1, ...items.map((item) => item.value));

  return (
    <section className="stats-card">
      <h4 className="stats-card__title">{title}</h4>

      {items.length === 0 ? (
        <div className="stats-card__empty">Nothing yet in this time range.</div>
      ) : (
        <ol className="top-list">
          {items.map((item) => (
            <li className="top-list__item" key={item.key} title={`${item.label}: ${item.value}`}>
              <span
                className="top-list__bar"
                style={{ width: `${(item.value / max) * 100}%` }}
                aria-hidden="true"
              />
              <span className="top-list__label">
                {item.icon?.emoji && (
                  <span className="top-list__icon" aria-hidden="true">
                    {item.icon.emoji}
                  </span>
                )}
                {item.icon?.className && (
                  <i className={`top-list__icon ${item.icon.className}`} aria-hidden="true" />
                )}
                <span className="top-list__name">{item.label}</span>
              </span>
              <span className="top-list__value">{formatNumber(item.value)}</span>
              <span className="top-list__percent">{formatPercent(item.value, total)}</span>
            </li>
          ))}
        </ol>
      )}

      {footer && <div className="stats-card__footer">{footer}</div>}
    </section>
  );
};

export default TopList;
