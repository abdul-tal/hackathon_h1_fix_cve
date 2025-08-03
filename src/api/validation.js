const Joi = require('joi');
const fs = require('fs-extra');
const path = require('path');

// CVE ID validation pattern (CVE-YYYY-NNNN)
const cveIdPattern = /^CVE-\d{4}-\d{4,}$/;

// Schema for fix CVE request
const fixCveSchema = Joi.object({
  cve_id: Joi.string()
    .pattern(cveIdPattern)
    .required()
    .messages({
      'string.pattern.base': 'CVE ID must be in format CVE-YYYY-NNNN (e.g., CVE-2023-1234)',
      'any.required': 'CVE ID is required'
    })
});

// Validate fix CVE request
const validateFixCveRequest = (req, res, next) => {
  const { error, value } = fixCveSchema.validate(req.body);
  
  if (error) {
    req.logger.warn('Request validation failed', {
      error: error.details[0].message,
      body: req.body
    });
    
    return res.status(400).json({
      status: 'failure',
      message: error.details[0].message,
      requestId: req.id
    });
  }
  
  req.validatedBody = value;
  next();
};

// Validate fix CVE repo request
const validateFixCveRepoRequest = (req, res, next) => {
  const schema = Joi.object({
    repo_url: Joi.string()
      .uri()
      .required()
      .messages({
        'string.uri': 'Repository URL must be a valid URI',
        'any.required': 'Repository URL is required'
      }),
    github_token: Joi.string()
      .min(1)
      .required()
      .messages({
        'string.min': 'GitHub token cannot be empty',
        'any.required': 'GitHub token is required'
      }),
    branch: Joi.string()
      .min(1)
      .max(100)
      .optional()
      .messages({
        'string.min': 'Branch name cannot be empty',
        'string.max': 'Branch name too long'
      }),
    dockerfile_path: Joi.string()
      .min(1)
      .max(500)
      .optional()
      .messages({
        'string.min': 'Dockerfile path cannot be empty',
        'string.max': 'Dockerfile path too long'
      })
  });

  const { error, value } = schema.validate(req.body);

  if (error) {
    req.logger.warn('Fix CVE repo request validation failed', {
      requestId: req.id,
      errors: error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }))
    });

    return res.status(400).json({
      error: 'Validation failed',
      details: error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      })),
      requestId: req.id,
      timestamp: new Date().toISOString()
    });
  }

  req.validatedBody = value;
  next();
};

// Check if Dockerfile exists at project root
const validateDockerfileExists = (req, res, next) => {
  const dockerfilePath = path.resolve('./Dockerfile');
  
  if (!fs.existsSync(dockerfilePath)) {
    req.logger.error('Dockerfile not found at project root', {
      path: dockerfilePath
    });
    
    return res.status(400).json({
      status: 'failure',
      message: 'Dockerfile not found at project root (./Dockerfile)',
      requestId: req.id
    });
  }
  
  req.dockerfilePath = dockerfilePath;
  next();
};

// Sanitize input to prevent injection attacks
const sanitizeInput = (req, res, next) => {
  if (req.validatedBody && req.validatedBody.cve_id) {
    // Additional sanitization for CVE ID
    req.validatedBody.cve_id = req.validatedBody.cve_id.trim().toUpperCase();
  }
  
  next();
};

module.exports = {
  validateFixCveRequest,
  validateFixCveRepoRequest,
  validateDockerfileExists,
  sanitizeInput,
  cveIdPattern
}; 