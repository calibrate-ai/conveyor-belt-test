const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// 404 handler for unknown routes
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  }).on('error', (err) => {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('Shutting down gracefully...');
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = app;
