const cors = require('cors');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// Request ID middleware
const requestId = (req, res, next) => {
  req.id = uuidv4();
  res.setHeader('X-Request-ID', req.id);
  req.logger = logger.addRequestId(req.id);
  next();
};

// Request logging middleware
const requestLogger = (req, res, next) => {
  const start = Date.now();
  
  req.logger.info('Request started', {
    method: req.method,
    url: req.url,
    userAgent: req.get('User-Agent'),
    ip: req.ip
  });

  // Log response
  const originalSend = res.send;
  res.send = function(data) {
    const duration = Date.now() - start;
    req.logger.info('Request completed', {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`
    });
    originalSend.call(this, data);
  };

  next();
};

// CORS configuration
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://yourdomain.com'] // Add your production domains
    : true, // Allow all origins in development
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  credentials: true
};

// Error handling middleware
const errorHandler = (err, req, res, next) => {
  const requestLogger = req.logger || logger;
  
  requestLogger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    method: req.method,
    url: req.url
  });

  // Don't expose internal errors in production
  const message = process.env.NODE_ENV === 'production' 
    ? 'Internal server error' 
    : err.message;

  res.status(err.status || 500).json({
    status: 'failure',
    message,
    requestId: req.id
  });
};

// 404 handler
const notFoundHandler = (req, res) => {
  req.logger.warn('Route not found', {
    method: req.method,
    url: req.url
  });

  res.status(404).json({
    status: 'failure',
    message: 'Route not found',
    requestId: req.id
  });
};

// Timeout middleware
const timeout = (duration = 300000) => { // 5 minutes default
  return (req, res, next) => {
    req.setTimeout(duration, () => {
      const err = new Error('Request timeout');
      err.status = 408;
      next(err);
    });
    next();
  };
};

module.exports = {
  requestId,
  requestLogger,
  cors: cors(corsOptions),
  bodyParser: express.json({ limit: '10mb' }),
  errorHandler,
  notFoundHandler,
  timeout
}; 