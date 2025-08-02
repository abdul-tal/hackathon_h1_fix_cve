# Task 004: Dockerfile Parser Tool

## Objective
Implement a tool to parse Dockerfiles and extract the current OS base image and version information.

## Deliverables

### 1. Dockerfile Parser
```javascript
class DockerfileParser {
  async parseDockerfile(dockerfilePath) {
    // Parse Dockerfile and extract all instructions
    // Return structured representation
  }
  
  extractBaseImage() {
    // Extract FROM instruction
    // Return { image: 'ubuntu', tag: '20.04', registry: 'docker.io' }
  }
  
  validateDockerfile() {
    // Validate Dockerfile syntax
    // Return validation errors if any
  }
}
```

### 2. Base Image Analysis
- Support multiple FROM statements (multi-stage builds)
- Handle different image formats:
  - `ubuntu:20.04`
  - `registry.com/ubuntu:20.04`
  - `ubuntu@sha256:...`
  - `ubuntu` (latest tag)

### 3. Version Extraction
- Parse semantic versions (20.04, 18.04.5)
- Handle different versioning schemes
- Identify OS family (Ubuntu, Alpine, CentOS, etc.)

### 4. Error Handling
- Invalid Dockerfile format
- Missing FROM instruction
- Unsupported base images
- Missing Dockerfile at root directory

## Acceptance Criteria
- [ ] Can parse valid Dockerfiles
- [ ] Extracts base image information correctly
- [ ] Handles multi-stage builds
- [ ] Supports different image formats
- [ ] Validates Dockerfile syntax
- [ ] Provides clear error messages

## Technical Notes
- Use regex patterns for parsing
- Support both local files and remote URLs
- Handle comments and whitespace properly
- Consider using dockerfile-ast library for parsing 