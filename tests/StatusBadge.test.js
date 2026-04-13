/**
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import StatusBadge from '../frontend/StatusBadge.jsx';

// Mock the CSS import so Jest doesn't choke on it
jest.mock('../frontend/StatusBadge.css', () => {});

describe('StatusBadge', () => {
  test('exports a function component', () => {
    expect(typeof StatusBadge).toBe('function');
  });

  test.each(['ok', 'error', 'loading'])('renders badge for status="%s"', (status) => {
    render(<StatusBadge status={status} />);
    const badge = screen.getByTestId('status-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('data-status', status);
  });

  test('renders correct label for each status', () => {
    const { rerender } = render(<StatusBadge status="ok" />);
    expect(screen.getByText('OK')).toBeInTheDocument();

    rerender(<StatusBadge status="error" />);
    expect(screen.getByText('Error')).toBeInTheDocument();

    rerender(<StatusBadge status="loading" />);
    expect(screen.getByText('Loading')).toBeInTheDocument();
  });

  test('uses className instead of inline styles', () => {
    render(<StatusBadge status="ok" />);
    const badge = screen.getByTestId('status-badge');
    expect(badge.className).toContain('status-badge');
    expect(badge.className).toContain('status-badge--ok');
    expect(badge.style.length).toBe(0);
  });

  test('loading badge dot has pulse class', () => {
    render(<StatusBadge status="loading" />);
    const badge = screen.getByTestId('status-badge');
    const dot = badge.querySelector('.status-badge__dot');
    expect(dot).toHaveClass('status-badge__dot--pulse');
  });

  test('non-loading badge dot does not have pulse class', () => {
    render(<StatusBadge status="ok" />);
    const badge = screen.getByTestId('status-badge');
    const dot = badge.querySelector('.status-badge__dot');
    expect(dot).not.toHaveClass('status-badge__dot--pulse');
  });

  // Accessibility
  test('has role="status" for screen readers', () => {
    render(<StatusBadge status="ok" />);
    const badge = screen.getByRole('status');
    expect(badge).toBeInTheDocument();
  });

  test('has descriptive aria-label', () => {
    render(<StatusBadge status="error" />);
    const badge = screen.getByRole('status');
    expect(badge).toHaveAttribute('aria-label', 'Pipeline status: Error');
  });

  // Unknown / invalid status
  test('returns null for unknown status', () => {
    const { container } = render(<StatusBadge status="unknown" />);
    expect(container.innerHTML).toBe('');
  });

  test('warns on unknown status in non-production', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    render(<StatusBadge status="bogus" />);
    expect(spy).toHaveBeenCalledWith('StatusBadge: unknown status "bogus"');
    spy.mockRestore();
  });

  // Prototype pollution guard (Gauntlet's bug)
  test.each(['__proto__', 'constructor', 'toString'])(
    'returns null for prototype key "%s"',
    (key) => {
      const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const { container } = render(<StatusBadge status={key} />);
      expect(container.innerHTML).toBe('');
      spy.mockRestore();
    },
  );
});
