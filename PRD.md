# Product Requirements Document: CVE Fix Automation Tool

## 1. Project Overview

### 1.1 Purpose
Build an AI CVE Fixer using Langchain that takes a CVE (Common Vulnerabilities and Exposures) number as input and automatically fixes it by upgrading the OS version in a Dockerfile

### 1.2 Target Users
- DevOps engineers
- Security teams
- Development teams managing containerized applications

### 1.3 Problem Statement
Manual CVE remediation is time-consuming and error-prone. Teams need to:
- Identify which OS version fixes a specific CVE
- Update Dockerfiles with minimal version bumps
- Ensure the updated image builds and runs successfully
- Create pull requests for code review

## 2. Functional Requirements

### 2.1 API Specification
- **Endpoint**: `POST /fix-cve`
- **Input**: 
  ```json
  {
    "cve_id": "CVE-2023-1234"
  }
  ```
- **Output**:
  ```json
  {
    "status": "success" | "failure" | "no_fix_available",
    "message": "Description of the action taken",
    "pr_url": "https://github.com/user/repo/pull/123", // if success
    "original_version": "ubuntu:20.04",
    "fixed_version": "ubuntu:20.04.5",
    "cve_details": {
      "severity": "HIGH",
      "description": "CVE description"
    }
  }
  ```

### 2.2 Agent Tools

#### Tool 1: Trivy Scanner
- **Purpose**: Scan Docker images for vulnerabilities
- **Input**: Docker image name/tag
- **Output**: List of CVEs with fix information
- **Key Features**:
  - Identify if a specific CVE exists in an image
  - Return the fixed version information
  - Handle cases where no fix is available

#### Tool 2: Dockerfile Updater
- **Purpose**: Create updated Dockerfile with new OS version
- **Input**: Original Dockerfile, target OS version
- **Output**: Updated Dockerfile content
- **Key Features**:
  - Parse existing Dockerfile
  - Update base image version
  - Preserve all other instructions

#### Tool 3: Docker Builder
- **Purpose**: Build Docker image from Dockerfile
- **Input**: Dockerfile path/content
- **Output**: Build success/failure status and logs
- **Key Features**:
  - Execute docker build command
  - Capture build logs
  - Return success/failure status

#### Tool 4: Docker Runner
- **Purpose**: Test if the built image runs successfully
- **Input**: Docker image name
- **Output**: Run success/failure status
- **Key Features**:
  - Run container with basic health checks
  - Timeout handling
  - Cleanup after testing

#### Tool 5: PR Creator
- **Purpose**: Create pull request with changes
- **Input**: Repository details, branch name, changes
- **Output**: PR URL and details
- **Key Features**:
  - Create new branch
  - Commit Dockerfile changes
  - Create PR with descriptive title/description
  - Link to CVE information

### 2.3 Core Algorithm

1. **Dockerfile Analysis**
   - Extract current OS base image and version
   - Validate Dockerfile format

2. **Version Discovery**
   - Query Docker Hub for available versions
   - Get latest version of the OS

3. **CVE Assessment**
   - Scan latest version for the target CVE
   - If CVE exists in latest → return "no fix available"
   - If CVE is fixed → proceed to find minimal fix version

4. **Minimal Version Finding**
   - Use sequential scan to find the lowest version that fixes the CVE
   - Start from current version + 1
   - Test each version with Trivy scan

5. **Image Validation**
   - Update Dockerfile with found version
   - Build Docker image
   - Run basic functionality test


## 3. Non-Functional Requirements

### 3.1 Performance
- API response time: < 5 minutes for typical CVE fixes
- Support concurrent requests (max 10 parallel)
- Efficient version searching algorithm

### 3.2 Reliability
- 99% uptime SLA
- Proper error handling and rollback
- Cleanup of temporary Docker images

### 3.3 Security
- API authentication/authorization
- Secure handling of repository credentials
- No exposure of sensitive information in logs

### 3.4 Scalability
- Horizontal scaling capability
- Queue-based processing for large requests
- Resource usage monitoring

## 4. Technical Architecture

### 4.1 Components
- **API Gateway**: REST API endpoint handling
- **Agent Orchestrator**: Main business logic and tool coordination
- **Tool Manager**: Interface for all 5 tools
- **Version Resolver**: Efficient CVE version finding
- **Repository Manager**: Git operations and PR creation

### 4.2 Technology Stack
- **Backend**: Node.js/Express
- **Containerization**: Docker
- **Security Scanning**: Trivy CLI
- **Version Control**: Git/GitHub API
- **Database**: PostgreSQL for logging and state management
- **Queue**: Redis/Celery for async processing

### 4.3 External Dependencies
- Docker Hub API
- GitHub API
- Trivy vulnerability database
- Docker daemon

## 5. Success Criteria

### 5.1 Primary Metrics
- Successfully fix 90% of fixable CVEs
- Reduce manual CVE remediation time by 80%
- Zero false positives in version selection

### 5.2 Secondary Metrics
- Average API response time < 3 minutes
- User satisfaction score > 4.5/5
- 95% successful Docker builds after updates

## 6. Constraints and Assumptions

### 6.1 Constraints
- Limited to Dockerfile-based projects
- Requires Docker Hub accessible base images
- GitHub-only repository support initially
- OS-level CVEs only (not application-level)

### 6.2 Assumptions
- Users have appropriate repository permissions
- Docker daemon is accessible
- Trivy database is up-to-date
- Base images follow semantic versioning

## 7. Risk Analysis

### 7.1 Technical Risks
- **Docker Hub rate limits**: Mitigate with caching and API keys
- **Trivy scan failures**: Implement retry logic and fallback mechanisms
- **Build failures**: Provide detailed error reporting and rollback

### 7.2 Business Risks
- **False security**: Ensure thorough testing before PR creation
- **Breaking changes**: Validate application compatibility after OS updates
- **Resource consumption**: Implement proper cleanup and monitoring

## 8. Future Enhancements

### 8.1 Phase 2 Features
- Support for multiple repository platforms (GitLab, Bitbucket)
- Application-level dependency updates
- Integration with CI/CD pipelines
- Batch CVE processing

### 8.2 Phase 3 Features
- ML-based compatibility prediction
- Custom testing framework integration
- Automated security regression testing
- Enterprise SSO integration 