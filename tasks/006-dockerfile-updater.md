# Task 006: Dockerfile Updater Tool

## Objective
Implement a tool to update Dockerfile with new OS version while preserving all other instructions and formatting.

## Deliverables

### 1. Dockerfile Updater
```javascript
class DockerfileUpdater {
  async updateBaseImage(dockerfilePath, newImage, newTag) {
    // Update FROM instruction with new version
    // Preserve original formatting and comments
    // Return updated Dockerfile content
  }
  
  async createBackup(dockerfilePath) {
    // Create backup of original Dockerfile
    // Return backup file path
  }
  
  async validateUpdate(originalContent, updatedContent) {
    // Validate that update only changed intended parts
    // Return validation results
  }
}
```

### 2. Update Logic
- Target specific FROM instruction (handle multi-stage builds)
- Preserve comments and formatting
- Maintain instruction order
- Handle edge cases (ARG before FROM, etc.)

### 3. Multi-stage Build Support
- Update correct stage based on context
- Handle dependencies between stages
- Preserve stage naming and aliases

### 4. Validation and Safety
- Verify only FROM instruction is changed
- Preserve all other instructions exactly
- Create backup before modification
- Rollback capability

## Acceptance Criteria
- [ ] Updates FROM instruction correctly
- [ ] Preserves all other Dockerfile content
- [ ] Handles multi-stage builds properly
- [ ] Creates backup before changes
- [ ] Validates changes are correct
- [ ] Supports rollback functionality

## Technical Notes
- Use string manipulation with regex
- Preserve original line endings and spacing
- Work with local Dockerfile at root directory (./Dockerfile)
- Consider using dockerfile-ast for robust parsing 