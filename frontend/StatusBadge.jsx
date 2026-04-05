import React from 'react';

const STATUS_CONFIG = {
  ok: { label: 'OK', color: '#22c55e', bg: '#f0fdf4' },
  error: { label: 'Error', color: '#ef4444', bg: '#fef2f2' },
  loading: { label: 'Loading', color: '#f59e0b', bg: '#fffbeb' },
};

/**
 * StatusBadge — renders a colored badge based on pipeline status.
 *
 * @param {{ status: 'ok' | 'error' | 'loading' }} props
 */
export default function StatusBadge({ status }) {
  const config = STATUS_CONFIG[status];

  if (!config) {
    return null;
  }

  const style = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 10px',
    borderRadius: '9999px',
    fontSize: '0.75rem',
    fontWeight: 600,
    lineHeight: 1,
    color: config.color,
    backgroundColor: config.bg,
    border: `1px solid ${config.color}`,
  };

  const dotStyle = {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    backgroundColor: config.color,
    ...(status === 'loading' && {
      animation: 'statusBadgePulse 1.2s ease-in-out infinite',
    }),
  };

  return (
    <span data-testid="status-badge" data-status={status} style={style}>
      <span style={dotStyle} />
      {config.label}
    </span>
  );
}
