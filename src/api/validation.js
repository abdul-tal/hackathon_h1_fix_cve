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
  validateDockerfileExists,
  sanitizeInput,
  cveIdPattern
}; 