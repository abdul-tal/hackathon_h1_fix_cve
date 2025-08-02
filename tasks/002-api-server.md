# Task 002: API Server Implementation

## Objective
Create the Express.js API server with the main `/fix-cve` endpoint and supporting infrastructure.

## Deliverables

### 1. Express.js Server Setup
- Basic Express app configuration
- Middleware setup (CORS, body parser, logging)
- Error handling middleware
- Health check endpoint (`GET /health`)

### 2. Main API Endpoint
```javascript
POST /fix-cve
Content-Type: application/json

Request Body:
{
  "cve_id": "CVE-2023-1234"
}

Response:
{
  "status": "success" | "failure" | "no_fix_available",
  "message": "Description of the action taken",
  "original_version": "ubuntu:20.04",
  "fixed_version": "ubuntu:20.04.5",
  "cve_details": {
    "severity": "HIGH",
    "description": "CVE description"
  }
}
```

### 3. Request Validation
- CVE ID format validation (CVE-YYYY-NNNN)
- Input sanitization
- Dockerfile existence check at project root

### 4. Response Handling
- Consistent response format
- HTTP status codes
- Error response structure

## Acceptance Criteria
- [ ] Express server starts successfully
- [ ] Health check endpoint responds correctly
- [ ] `/fix-cve` endpoint accepts requests
- [ ] Input validation works properly
- [ ] Error responses are properly formatted
- [ ] Logging captures all requests

## Technical Notes
- Use async/await for all handlers
- Implement request timeout (5 minutes)
- Add request ID for tracing
- Set up proper CORS headers 