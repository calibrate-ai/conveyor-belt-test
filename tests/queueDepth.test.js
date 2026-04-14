const { checkQueueDepths, getSeverity, emitQueueAlert, DEFAULT_CONFIG } = require('../backend/monitoring/queueDepth');

function createMockRedis(depths = {}) {
  return {
    llen: jest.fn().mockImplementation((key) => Promise.resolve(depths[key] || 0)),
  };
}

const config = {
  queues: { main: 'ai_events', dlq: 'ai_events_dlq', archive: 'ai_events_dead' },
  thresholds: { mainWarning: 100, mainCritical: 1000, dlqWarning: 1, dlqCritical: 10 },
};

describe('queueDepth monitoring', () => {
  describe('getSeverity', () => {
    it('returns ok below warning threshold', () => {
      expect(getSeverity(0, 100, 1000)).toBe('ok');
      expect(getSeverity(99, 100, 1000)).toBe('ok');
    });

    it('returns warning at warning threshold', () => {
      expect(getSeverity(100, 100, 1000)).toBe('warning');
      expect(getSeverity(500, 100, 1000)).toBe('warning');
    });

    it('returns critical at critical threshold', () => {
      expect(getSeverity(1000, 100, 1000)).toBe('critical');
      expect(getSeverity(5000, 100, 1000)).toBe('critical');
    });
  });

  describe('emitQueueAlert', () => {
    it('emits warning to console.warn', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const alert = emitQueueAlert('ai_events', 150, 'warning', { warning: 100, critical: 1000 });
      expect(alert.level).toBe('warn');
      expect(alert.code).toBe('QUEUE-DEPTH');
      expect(alert.queue).toBe('ai_events');
      expect(alert.depth).toBe(150);
      expect(alert.severity).toBe('warning');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it('emits critical to console.error', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const alert = emitQueueAlert('ai_events', 2000, 'critical', { warning: 100, critical: 1000 });
      expect(alert.level).toBe('alert');
      expect(alert.severity).toBe('critical');
      expect(errorSpy).toHaveBeenCalledTimes(1);
      errorSpy.mockRestore();
    });

    it('includes thresholds in alert', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const alert = emitQueueAlert('q', 50, 'warning', { warning: 10, critical: 100 });
      expect(alert.warning_threshold).toBe(10);
      expect(alert.critical_threshold).toBe(100);
      warnSpy.mockRestore();
    });
  });

  describe('checkQueueDepths', () => {
    it('returns ok when all queues are empty', async () => {
      const redis = createMockRedis({ ai_events: 0, ai_events_dlq: 0, ai_events_dead: 0 });
      const result = await checkQueueDepths(redis, config);
      expect(result.status).toBe('ok');
      expect(result.alerts).toHaveLength(0);
      expect(result.depths.ai_events).toBe(0);
    });

    it('returns warning when main queue exceeds warning threshold', async () => {
      const redis = createMockRedis({ ai_events: 150, ai_events_dlq: 0, ai_events_dead: 0 });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await checkQueueDepths(redis, config);
      warnSpy.mockRestore();
      expect(result.status).toBe('warning');
      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0].queue).toBe('ai_events');
    });

    it('returns critical when main queue exceeds critical threshold', async () => {
      const redis = createMockRedis({ ai_events: 2000, ai_events_dlq: 0, ai_events_dead: 0 });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const result = await checkQueueDepths(redis, config);
      errorSpy.mockRestore();
      expect(result.status).toBe('critical');
      expect(result.alerts[0].severity).toBe('critical');
    });

    it('alerts on any DLQ events (warning threshold = 1)', async () => {
      const redis = createMockRedis({ ai_events: 0, ai_events_dlq: 3, ai_events_dead: 0 });
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await checkQueueDepths(redis, config);
      warnSpy.mockRestore();
      expect(result.status).toBe('warning');
      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0].queue).toBe('ai_events_dlq');
    });

    it('returns critical when DLQ exceeds critical threshold', async () => {
      const redis = createMockRedis({ ai_events: 0, ai_events_dlq: 15, ai_events_dead: 0 });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const result = await checkQueueDepths(redis, config);
      errorSpy.mockRestore();
      expect(result.status).toBe('critical');
    });

    it('returns multiple alerts when both queues breach thresholds', async () => {
      const redis = createMockRedis({ ai_events: 500, ai_events_dlq: 5, ai_events_dead: 10 });
      const spies = [
        jest.spyOn(console, 'warn').mockImplementation(() => {}),
        jest.spyOn(console, 'error').mockImplementation(() => {}),
      ];
      const result = await checkQueueDepths(redis, config);
      spies.forEach((s) => s.mockRestore());
      expect(result.alerts).toHaveLength(2);
      expect(result.status).toBe('warning');
    });

    it('reports archive depth without alerting', async () => {
      const redis = createMockRedis({ ai_events: 0, ai_events_dlq: 0, ai_events_dead: 500 });
      const result = await checkQueueDepths(redis, config);
      expect(result.status).toBe('ok');
      expect(result.depths.ai_events_dead).toBe(500);
      expect(result.alerts).toHaveLength(0);
    });

    it('includes checked_at timestamp', async () => {
      const redis = createMockRedis({});
      const result = await checkQueueDepths(redis, config);
      expect(result.checked_at).toBeDefined();
      const ts = new Date(result.checked_at);
      expect(ts.toISOString()).toBe(result.checked_at);
    });

    it('checks all three queues via llen', async () => {
      const redis = createMockRedis({});
      await checkQueueDepths(redis, config);
      expect(redis.llen).toHaveBeenCalledTimes(3);
      expect(redis.llen).toHaveBeenCalledWith('ai_events');
      expect(redis.llen).toHaveBeenCalledWith('ai_events_dlq');
      expect(redis.llen).toHaveBeenCalledWith('ai_events_dead');
    });
  });

  describe('DEFAULT_CONFIG', () => {
    it('has sensible default thresholds', () => {
      expect(DEFAULT_CONFIG.thresholds.mainWarning).toBeGreaterThan(0);
      expect(DEFAULT_CONFIG.thresholds.mainCritical).toBeGreaterThan(DEFAULT_CONFIG.thresholds.mainWarning);
      expect(DEFAULT_CONFIG.thresholds.dlqWarning).toBe(1);
      expect(DEFAULT_CONFIG.thresholds.dlqCritical).toBeGreaterThan(DEFAULT_CONFIG.thresholds.dlqWarning);
    });
  });
});
