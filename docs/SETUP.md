# CVE Fix Automation Tool - Setup Guide

## Environment Variables Setup

### Step 1: Create .env File

Create a `.env` file in the project root with the following variables:

```bash
# Copy this template to .env and fill in your values

# API Configuration
PORT=3000
NODE_ENV=development

# OpenAI Configuration (for Langchain Agent)
# Get your API key from: https://platform.openai.com/api-keys
# Without this, the tool will run in direct mode (no LLM agent)
OPENAI_API_KEY=sk-your-openai-api-key-here

# Docker Configuration
# For local Docker daemon on Linux/macOS
DOCKER_HOST=unix:///var/run/docker.sock

# For Docker Desktop on macOS (alternative)
# DOCKER_HOST=unix:///Users/[username]/.docker/run/docker.sock

# For Docker Desktop on Windows
# DOCKER_HOST=npipe:////./pipe/docker_engine

# For remote Docker daemon
# DOCKER_HOST=tcp://hostname:2376

# Docker Hub Configuration (optional - for higher rate limits)
# Without these, you'll hit Docker Hub's anonymous rate limits (~100 requests/6 hours)
# Get credentials from: https://hub.docker.com/settings/security
DOCKER_HUB_USERNAME=your-docker-hub-username
DOCKER_HUB_PASSWORD=your-docker-hub-password-or-token

# GitHub Configuration (for future PR creation - optional)
# Get token from: https://github.com/settings/tokens
# Requires repo permissions for private repos, public_repo for public repos
GITHUB_TOKEN=ghp_your-github-token-here

# Trivy Configuration
TRIVY_CACHE_DIR=./trivy-cache
TRIVY_TIMEOUT=300000

# Logging Configuration
LOG_LEVEL=info
LOG_FILE=./logs/cve-fix.log

# Performance Configuration
MAX_CONCURRENT_SCANS=3
BUILD_TIMEOUT=600000
RUN_TIMEOUT=30000

# Version Search Strategy
# Options: sequential, binary, auto
VERSION_SEARCH_STRATEGY=sequential
```

### Step 2: Quick Setup Commands

```bash
# Create .env file from template
cp docs/env-template .env

# Edit with your values
nano .env  # or vim .env, or code .env

# Create required directories
mkdir -p logs trivy-cache

# Install Trivy (if not already installed)
# On macOS
brew install trivy

# On Linux
sudo apt-get install wget apt-transport-https gnupg lsb-release
wget -qO - https://aquasecurity.github.io/trivy-repo/deb/public.key | sudo apt-key add -
echo "deb https://aquasecurity.github.io/trivy-repo/deb $(lsb_release -sc) main" | sudo tee -a /etc/apt/sources.list.d/trivy.list
sudo apt-get update
sudo apt-get install trivy

# Verify setup
npm run start
curl http://localhost:3000/api/requirements
```

## Required Dependencies

### 1. Docker (Required)
- **Local Development**: Docker Desktop or Docker Engine
- **Production**: Docker daemon accessible via socket or TCP

### 2. Trivy CLI (Required)
- **Installation**: See commands above
- **Purpose**: CVE scanning and vulnerability detection

### 3. OpenAI API Key (Optional)
- **Purpose**: Enables full LLM agent mode
- **Fallback**: Tool works in direct mode without LLM
- **Get Key**: https://platform.openai.com/api-keys

### 4. Docker Hub Credentials (Optional)
- **Purpose**: Higher API rate limits
- **Anonymous Limit**: ~100 requests per 6 hours
- **With Auth**: ~200 requests per 6 hours per user

## Configuration Validation

The tool provides several endpoints to validate your setup:

```bash
# Check system requirements
curl http://localhost:3000/api/requirements

# Check overall health
curl http://localhost:3000/api/health

# View current configuration
curl http://localhost:3000/api/status
```

## Common Issues & Solutions

### 1. Docker Connection Issues

**Problem**: "Docker daemon not accessible: Invalid URL"

**Solutions**:
```bash
# Check Docker is running
docker ps

# For macOS Docker Desktop, try:
DOCKER_HOST=unix:///Users/$(whoami)/.docker/run/docker.sock

# For Linux:
DOCKER_HOST=unix:///var/run/docker.sock

# For Windows:
DOCKER_HOST=npipe:////./pipe/docker_engine
```

### 2. Docker Hub Rate Limits

**Problem**: "Request failed with status code 429"

**Solutions**:
- Add Docker Hub credentials to `.env`
- Use Docker Hub personal access token instead of password
- Wait for rate limit reset (6 hours)

### 3. Trivy Not Found

**Problem**: "Trivy CLI is not installed"

**Solutions**:
```bash
# Verify installation
trivy --version

# Update PATH if needed
export PATH=$PATH:/usr/local/bin

# Install via package manager (see above)
```

### 4. Permission Issues

**Problem**: "EACCES: permission denied"

**Solutions**:
```bash
# For Docker socket
sudo chmod 666 /var/run/docker.sock

# For logs directory
sudo chown -R $(whoami) logs/

# For Trivy cache
sudo chown -R $(whoami) trivy-cache/
```

## Environment-Specific Configurations

### Development
```bash
NODE_ENV=development
LOG_LEVEL=debug
DOCKER_HOST=unix:///var/run/docker.sock
```

### Production
```bash
NODE_ENV=production
LOG_LEVEL=info
DOCKER_HOST=unix:///var/run/docker.sock
# Add authentication tokens
```

### CI/CD
```bash
NODE_ENV=test
LOG_LEVEL=warn
DOCKER_HOST=tcp://docker:2376
# Use service accounts
```

## Testing Configuration

```bash
# Test with minimal config (no auth)
npm start

# Test CVE fix with real CVE
curl -X POST http://localhost:3000/api/fix-cve \
  -H "Content-Type: application/json" \
  -d '{"cve_id": "CVE-2021-3711"}'

# Expected: Should progress through workflow until Docker Hub auth needed
``` 