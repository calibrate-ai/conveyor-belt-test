import React from 'react';
import PropTypes from 'prop-types';
import './StatusBadge.css';

const STATUS_CONFIG = {
  ok: { label: 'OK', color: 'ok' },
  error: { label: 'Error', color: 'error' },
  loading: { label: 'Loading', color: 'loading' },
};

/**
 * StatusBadge — renders a colored badge based on pipeline status.
 *
 * @param {{ status: 'ok' | 'error' | 'loading' }} props
 */
export default function StatusBadge({ status }) {
  if (!Object.hasOwn(STATUS_CONFIG, status)) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`StatusBadge: unknown status "${status}"`);
    }
    return null;
  }

  const config = STATUS_CONFIG[status];

  return (
    <span
      className={`status-badge status-badge--${config.color}`}
      data-testid="status-badge"
      data-status={status}
      role="status"
      aria-label={`Pipeline status: ${config.label}`}
    >
      <span
        className={`status-badge__dot${status === 'loading' ? ' status-badge__dot--pulse' : ''}`}
      />
      {config.label}
    </span>
  );
}

StatusBadge.propTypes = {
  status: PropTypes.oneOf(['ok', 'error', 'loading']).isRequired,
};
