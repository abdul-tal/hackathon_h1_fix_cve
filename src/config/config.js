const path = require('path');

// Load environment variables
require('dotenv').config();

const config = {
  // API Configuration
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  // OpenAI Configuration
  openai: {
    apiKey: process.env.OPENAI_API_KEY
  },

  // Docker Configuration
  docker: {
    host: process.env.DOCKER_HOST || 'unix:///var/run/docker.sock',
    buildTimeout: parseInt(process.env.BUILD_TIMEOUT) || 600000, // 10 minutes
    runTimeout: parseInt(process.env.RUN_TIMEOUT) || 30000 // 30 seconds
  },

  // GitHub Configuration
  github: {
    token: process.env.GITHUB_TOKEN
  },

  // Docker Hub Configuration
  dockerHub: {
    username: process.env.DOCKER_HUB_USERNAME,
    password: process.env.DOCKER_HUB_PASSWORD
  },

  // Trivy Configuration
  trivy: {
    cacheDir: process.env.TRIVY_CACHE_DIR || './trivy-cache',
    timeout: parseInt(process.env.TRIVY_TIMEOUT) || 300000 // 5 minutes
  },

  // Logging Configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || './logs/cve-fix.log'
  },

  // Performance Configuration
  performance: {
    maxConcurrentScans: parseInt(process.env.MAX_CONCURRENT_SCANS) || 3
  },

  // Version Search Configuration
  versionSearch: {
    strategy: process.env.VERSION_SEARCH_STRATEGY || 'sequential' // sequential, binary, auto
  },

  // Dockerfile Configuration
  dockerfile: {
    path: './Dockerfile',
    backupSuffix: '.backup'
  }
};

module.exports = config; 