const fs = require('fs-extra');
const path = require('path');
const { DockerfileParser: ASTParser } = require('dockerfile-ast');
const config = require('../config/config');
const logger = require('../utils/logger');

class DockerfileUpdater {
  constructor() {
    this.backupSuffix = config.dockerfile.backupSuffix || '.backup';
  }

  // Update base image in Dockerfile
  async updateBaseImage(dockerfilePath, newImage, newTag, options = {}) {
    try {
      logger.info('Updating Dockerfile base image', {
        path: dockerfilePath,
        newImage,
        newTag
      });

      // Read current Dockerfile content
      const originalContent = await fs.readFile(dockerfilePath, 'utf8');
      
      // Create backup first
      const backupPath = await this.createBackup(dockerfilePath);
      
      // Parse Dockerfile to find FROM instructions
      const astParser = ASTParser.parse(originalContent);
      const instructions = astParser.getInstructions();
      
      // Find FROM instructions
      const fromInstructions = instructions.filter(
        instr => instr.getKeyword().toUpperCase() === 'FROM'
      );

      if (fromInstructions.length === 0) {
        throw new Error('No FROM instructions found in Dockerfile');
      }

      // Determine which FROM instruction to update
      const targetStage = options.stageIndex || 0;
      const targetFromInstruction = fromInstructions[targetStage];
      
      if (!targetFromInstruction) {
        throw new Error(`FROM instruction at stage ${targetStage} not found`);
      }

      // Update the FROM instruction
      const updatedContent = this.replaceFromInstruction(
        originalContent,
        targetFromInstruction,
        newImage,
        newTag,
        options
      );

      // Validate the update
      const validation = await this.validateUpdate(originalContent, updatedContent);
      if (!validation.isValid) {
        throw new Error(`Update validation failed: ${validation.issues.join(', ')}`);
      }

      // Write updated content
      await fs.writeFile(dockerfilePath, updatedContent, 'utf8');

      logger.info('Dockerfile updated successfully', {
        path: dockerfilePath,
        backupPath,
        newImage,
        newTag
      });

      return {
        success: true,
        originalContent,
        updatedContent,
        backupPath,
        changes: {
          fromImage: newImage,
          fromTag: newTag,
          stageIndex: targetStage
        }
      };

    } catch (error) {
      logger.error('Failed to update Dockerfile', {
        path: dockerfilePath,
        newImage,
        newTag,
        error: error.message
      });
      
      // Attempt to restore from backup if it exists
      await this.restoreFromBackup(dockerfilePath);
      
      throw new Error(`Failed to update Dockerfile: ${error.message}`);
    }
  }

  // Replace FROM instruction in Dockerfile content
  replaceFromInstruction(content, fromInstruction, newImage, newTag, options = {}) {
    try {
      const range = fromInstruction.getRange();
      const startLine = range.start.line;
      const endLine = range.end.line;
      
      const lines = content.split('\n');
      const originalFromLine = lines[startLine];
      
      logger.debug('Replacing FROM instruction', {
        originalLine: originalFromLine,
        lineNumber: startLine + 1
      });

      // Parse the original FROM instruction to preserve formatting
      const fromData = this.parseFromLine(originalFromLine);
      
      // Build new FROM instruction
      const newFromLine = this.buildFromLine(fromData, newImage, newTag, options);
      
      // Replace the line
      lines[startLine] = newFromLine;
      
      logger.debug('FROM instruction replaced', {
        originalLine: originalFromLine,
        newLine: newFromLine,
        lineNumber: startLine + 1
      });

      return lines.join('\n');

    } catch (error) {
      logger.error('Failed to replace FROM instruction', {
        error: error.message
      });
      throw error;
    }
  }

  // Parse FROM line to extract components
  parseFromLine(fromLine) {
    const trimmedLine = fromLine.trim();
    
    const fromData = {
      indentation: fromLine.match(/^(\s*)/)[1] || '',
      platform: null,
      alias: null,
      comment: null
    };

    // Extract inline comments
    const commentMatch = fromLine.match(/^(.+?)\s*#\s*(.+)$/);
    if (commentMatch) {
      fromData.comment = commentMatch[2];
      fromLine = commentMatch[1].trim();
    }

    // Extract platform specification
    let workingLine = fromLine.replace(/^\s*FROM\s+/i, '');
    const platformMatch = workingLine.match(/^--platform=([^\s]+)\s+(.+)$/);
    if (platformMatch) {
      fromData.platform = platformMatch[1];
      workingLine = platformMatch[2];
    }

    // Extract alias
    const aliasMatch = workingLine.match(/^(.+?)\s+AS\s+(.+)$/i);
    if (aliasMatch) {
      workingLine = aliasMatch[1].trim();
      fromData.alias = aliasMatch[2].trim();
    }

    fromData.imageSpec = workingLine;

    return fromData;
  }

  // Build new FROM line with updated image
  buildFromLine(fromData, newImage, newTag, options = {}) {
    let fromLine = fromData.indentation + 'FROM';

    // Add platform if present
    if (fromData.platform) {
      fromLine += ` --platform=${fromData.platform}`;
    }

    // Add new image:tag
    fromLine += ` ${newImage}:${newTag}`;

    // Add alias if present
    if (fromData.alias) {
      fromLine += ` AS ${fromData.alias}`;
    }

    // Add comment if present
    if (fromData.comment) {
      fromLine += ` # ${fromData.comment}`;
    }

    return fromLine;
  }

  // Create backup of original Dockerfile
  async createBackup(dockerfilePath) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${dockerfilePath}${this.backupSuffix}.${timestamp}`;
      
      await fs.copy(dockerfilePath, backupPath);
      
      logger.debug('Backup created', {
        originalPath: dockerfilePath,
        backupPath
      });

      return backupPath;

    } catch (error) {
      logger.error('Failed to create backup', {
        path: dockerfilePath,
        error: error.message
      });
      throw new Error(`Failed to create backup: ${error.message}`);
    }
  }

  // Restore from backup
  async restoreFromBackup(dockerfilePath) {
    try {
      // Find the most recent backup
      const dir = path.dirname(dockerfilePath);
      const basename = path.basename(dockerfilePath);
      const backupPattern = `${basename}${this.backupSuffix}`;
      
      const files = await fs.readdir(dir);
      const backupFiles = files
        .filter(file => file.startsWith(backupPattern))
        .sort()
        .reverse(); // Most recent first

      if (backupFiles.length === 0) {
        logger.warn('No backup files found for restoration', { dockerfilePath });
        return false;
      }

      const latestBackup = path.join(dir, backupFiles[0]);
      await fs.copy(latestBackup, dockerfilePath);
      
      logger.info('Restored from backup', {
        dockerfilePath,
        backupFile: latestBackup
      });

      return true;

    } catch (error) {
      logger.error('Failed to restore from backup', {
        dockerfilePath,
        error: error.message
      });
      return false;
    }
  }

  // Validate that update only changed intended parts
  async validateUpdate(originalContent, updatedContent) {
    try {
      const validation = {
        isValid: true,
        issues: []
      };

      // Basic checks
      if (originalContent === updatedContent) {
        validation.issues.push('No changes detected in Dockerfile');
      }

      // Check that we still have FROM instructions
      const originalFrom = (originalContent.match(/^FROM\s+/gim) || []).length;
      const updatedFrom = (updatedContent.match(/^FROM\s+/gim) || []).length;
      
      if (originalFrom !== updatedFrom) {
        validation.issues.push('Number of FROM instructions changed');
      }

      // Check that other instructions are preserved
      const originalLines = originalContent.split('\n');
      const updatedLines = updatedContent.split('\n');
      
      if (originalLines.length !== updatedLines.length) {
        validation.issues.push('Number of lines changed');
      }

      // Count changes (should be minimal)
      let changedLines = 0;
      for (let i = 0; i < Math.min(originalLines.length, updatedLines.length); i++) {
        if (originalLines[i] !== updatedLines[i]) {
          changedLines++;
        }
      }

      if (changedLines > 2) { // Allow for minor changes
        validation.issues.push(`Too many lines changed: ${changedLines}`);
      }

      // Try to parse both versions
      try {
        ASTParser.parse(originalContent);
        ASTParser.parse(updatedContent);
      } catch (parseError) {
        validation.issues.push(`Dockerfile parsing failed: ${parseError.message}`);
      }

      validation.isValid = validation.issues.length === 0;

      logger.debug('Update validation completed', {
        isValid: validation.isValid,
        issues: validation.issues,
        changedLines
      });

      return validation;

    } catch (error) {
      logger.error('Update validation failed', {
        error: error.message
      });
      
      return {
        isValid: false,
        issues: [`Validation error: ${error.message}`]
      };
    }
  }

  // Clean up old backup files
  async cleanupBackups(dockerfilePath, keepCount = 5) {
    try {
      const dir = path.dirname(dockerfilePath);
      const basename = path.basename(dockerfilePath);
      const backupPattern = `${basename}${this.backupSuffix}`;
      
      const files = await fs.readdir(dir);
      const backupFiles = files
        .filter(file => file.startsWith(backupPattern))
        .map(file => ({
          name: file,
          path: path.join(dir, file),
          stat: fs.statSync(path.join(dir, file))
        }))
        .sort((a, b) => b.stat.mtime - a.stat.mtime); // Newest first

      // Keep only the most recent backups
      const filesToDelete = backupFiles.slice(keepCount);
      
      for (const file of filesToDelete) {
        await fs.remove(file.path);
        logger.debug('Old backup deleted', { path: file.path });
      }

      if (filesToDelete.length > 0) {
        logger.info('Backup cleanup completed', {
          deletedCount: filesToDelete.length,
          keptCount: Math.min(backupFiles.length, keepCount)
        });
      }

    } catch (error) {
      logger.warn('Backup cleanup failed', {
        dockerfilePath,
        error: error.message
      });
    }
  }

  // Get list of backup files
  async getBackupFiles(dockerfilePath) {
    try {
      const dir = path.dirname(dockerfilePath);
      const basename = path.basename(dockerfilePath);
      const backupPattern = `${basename}${this.backupSuffix}`;
      
      const files = await fs.readdir(dir);
      const backupFiles = files
        .filter(file => file.startsWith(backupPattern))
        .map(file => {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);
          return {
            name: file,
            path: fullPath,
            size: stat.size,
            created: stat.mtime,
            isRecent: Date.now() - stat.mtime.getTime() < 24 * 60 * 60 * 1000 // 24 hours
          };
        })
        .sort((a, b) => b.created - a.created);

      return backupFiles;

    } catch (error) {
      logger.error('Failed to get backup files', {
        dockerfilePath,
        error: error.message
      });
      return [];
    }
  }
}

module.exports = DockerfileUpdater; 