# Task 003: Trivy Scanner Tool Implementation

## Objective
Implement the Trivy scanner tool that can scan Docker images for CVEs and determine if a specific CVE is fixed in a given image version.

## Deliverables

### 1. Trivy CLI Integration
- Install and configure Trivy CLI
- Wrapper functions for Trivy commands
- Error handling for Trivy failures

### 2. Core Functionality
```javascript
class TrivyTool {
  async scanImage(imageName, imageTag) {
    // Scan Docker image for vulnerabilities
    // Return structured vulnerability data
  }
  
  async checkCVEStatus(imageName, imageTag, cveId) {
    // Check if specific CVE exists in the image
    // Return: { exists: boolean, severity: string, fixedVersion: string | null }
  }
  
  async findFixedVersion(imageName, cveId, versions) {
    // Check multiple versions to find which one fixes the CVE
    // Return the earliest version that fixes the CVE
  }
}
```

### 3. Output Parsing
- Parse Trivy JSON output
- Extract CVE information
- Handle different output formats
- Map severity levels

### 4. Performance Optimization
- Cache scan results temporarily
- Parallel scanning for multiple versions
- Timeout handling for long scans

## Acceptance Criteria
- [ ] Trivy CLI is properly integrated
- [ ] Can scan any Docker image
- [ ] Accurately identifies CVE presence
- [ ] Returns structured vulnerability data
- [ ] Handles network failures gracefully
- [ ] Performance is optimized for batch operations

## Technical Notes
- Use Trivy's JSON output format
- Implement retry logic for network issues
- Set appropriate timeouts for scans
- Handle Docker Hub rate limits
- Cache database updates 