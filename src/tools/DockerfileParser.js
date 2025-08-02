const fs = require('fs-extra');
const path = require('path');
const { DockerfileParser: ASTParser } = require('dockerfile-ast');
const logger = require('../utils/logger');

class DockerfileParser {
  constructor() {
    this.supportedRegistries = [
      'docker.io',
      'registry.hub.docker.com',
      'gcr.io',
      'ghcr.io',
      'quay.io'
    ];
  }

  // Parse Dockerfile and return structured representation
  async parseDockerfile(dockerfilePath) {
    try {
      logger.info('Parsing Dockerfile', { path: dockerfilePath });
      
      // Check if file exists
      if (!await fs.pathExists(dockerfilePath)) {
        throw new Error(`Dockerfile not found at ${dockerfilePath}`);
      }

      // Read file content
      const content = await fs.readFile(dockerfilePath, 'utf8');
      
      // Parse with dockerfile-ast for robust parsing
      const astParser = ASTParser.parse(content);
      
      // Extract instructions
      const instructions = astParser.getInstructions();
      
      const parseResult = {
        path: dockerfilePath,
        content,
        instructions: [],
        fromInstructions: [],
        isMultiStage: false,
        stages: []
      };

      // Process each instruction
      for (const instruction of instructions) {
        const instructionData = {
          keyword: instruction.getKeyword(),
          range: instruction.getRange(),
          arguments: instruction.getArgumentsContent()
        };

        parseResult.instructions.push(instructionData);

        // Special handling for FROM instructions
        if (instruction.getKeyword().toUpperCase() === 'FROM') {
          const fromData = this.parseFromInstruction(instruction);
          parseResult.fromInstructions.push(fromData);
        }
      }

      // Analyze multi-stage builds
      parseResult.isMultiStage = parseResult.fromInstructions.length > 1;
      parseResult.stages = this.analyzeStages(parseResult.fromInstructions);

      logger.info('Dockerfile parsed successfully', {
        path: dockerfilePath,
        instructionCount: parseResult.instructions.length,
        fromInstructions: parseResult.fromInstructions.length,
        isMultiStage: parseResult.isMultiStage
      });

      return parseResult;

    } catch (error) {
      logger.error('Failed to parse Dockerfile', {
        path: dockerfilePath,
        error: error.message
      });
      throw new Error(`Failed to parse Dockerfile: ${error.message}`);
    }
  }

  // Parse FROM instruction to extract image information
  parseFromInstruction(fromInstruction) {
    const argumentsContent = fromInstruction.getArgumentsContent();
    const fromData = {
      raw: argumentsContent,
      image: null,
      tag: null,
      digest: null,
      registry: null,
      alias: null,
      platform: null,
      isBaseImage: true
    };

    try {
      // Handle platform specification: FROM --platform=linux/amd64 ubuntu:20.04
      let imageSpec = argumentsContent;
      if (imageSpec.includes('--platform=')) {
        const platformMatch = imageSpec.match(/--platform=([^\s]+)/);
        if (platformMatch) {
          fromData.platform = platformMatch[1];
          imageSpec = imageSpec.replace(/--platform=[^\s]+\s*/, '').trim();
        }
      }

      // Handle alias: FROM ubuntu:20.04 AS builder
      const aliasMatch = imageSpec.match(/^(.+?)\s+AS\s+(.+)$/i);
      if (aliasMatch) {
        imageSpec = aliasMatch[1].trim();
        fromData.alias = aliasMatch[2].trim();
      }

      // Handle digest: ubuntu@sha256:abc123...
      const digestMatch = imageSpec.match(/^(.+?)@(sha256:[a-f0-9]+)$/);
      if (digestMatch) {
        imageSpec = digestMatch[1];
        fromData.digest = digestMatch[2];
      }

      // Parse registry/image:tag
      const parts = imageSpec.split('/');
      let imagePart;

      if (parts.length === 1) {
        // Just image:tag (e.g., ubuntu:20.04)
        fromData.registry = 'docker.io';
        imagePart = parts[0];
      } else if (parts.length === 2) {
        if (parts[0].includes('.') || parts[0] === 'localhost') {
          // registry.com/image:tag
          fromData.registry = parts[0];
          imagePart = parts[1];
        } else {
          // namespace/image:tag (Docker Hub)
          fromData.registry = 'docker.io';
          imagePart = imageSpec;
        }
      } else {
        // registry.com/namespace/image:tag
        fromData.registry = parts[0];
        imagePart = parts.slice(1).join('/');
      }

      // Parse image:tag
      const tagMatch = imagePart.match(/^(.+?):(.+)$/);
      if (tagMatch) {
        fromData.image = tagMatch[1];
        fromData.tag = tagMatch[2];
      } else {
        fromData.image = imagePart;
        fromData.tag = 'latest';
      }

      // Clean up image name (remove namespace for Docker Hub)
      if (fromData.registry === 'docker.io' && fromData.image.includes('/')) {
        const imageParts = fromData.image.split('/');
        if (imageParts.length === 2) {
          // Keep namespace/image format for Docker Hub
          fromData.image = fromData.image;
        }
      }

      logger.debug('Parsed FROM instruction', fromData);
      return fromData;

    } catch (error) {
      logger.error('Failed to parse FROM instruction', {
        raw: argumentsContent,
        error: error.message
      });
      throw new Error(`Failed to parse FROM instruction: ${error.message}`);
    }
  }

  // Extract base image information from parsed Dockerfile
  extractBaseImage(parseResult, stageIndex = 0) {
    try {
      if (!parseResult.fromInstructions || parseResult.fromInstructions.length === 0) {
        throw new Error('No FROM instructions found in Dockerfile');
      }

      if (stageIndex >= parseResult.fromInstructions.length) {
        throw new Error(`Stage index ${stageIndex} is out of range`);
      }

      const fromInstruction = parseResult.fromInstructions[stageIndex];
      
      // Skip if this FROM references another stage
      if (this.isStageReference(fromInstruction, parseResult)) {
        fromInstruction.isBaseImage = false;
        if (stageIndex < parseResult.fromInstructions.length - 1) {
          // Try next stage
          return this.extractBaseImage(parseResult, stageIndex + 1);
        } else {
          throw new Error('No base image found - all FROM instructions reference other stages');
        }
      }

      logger.debug('Extracted base image', {
        image: fromInstruction.image,
        tag: fromInstruction.tag,
        registry: fromInstruction.registry,
        stageIndex
      });

      return fromInstruction;

    } catch (error) {
      logger.error('Failed to extract base image', {
        error: error.message,
        stageIndex
      });
      throw error;
    }
  }

  // Check if FROM instruction references another stage
  isStageReference(fromInstruction, parseResult) {
    const imageName = fromInstruction.image;
    
    // Check if image name matches any stage alias
    for (const fromInstr of parseResult.fromInstructions) {
      if (fromInstr.alias && fromInstr.alias === imageName) {
        return true;
      }
    }
    
    return false;
  }

  // Analyze stages in multi-stage build
  analyzeStages(fromInstructions) {
    return fromInstructions.map((fromInstr, index) => ({
      index,
      alias: fromInstr.alias || `stage-${index}`,
      baseImage: fromInstr.image,
      tag: fromInstr.tag,
      registry: fromInstr.registry,
      isBaseImage: fromInstr.isBaseImage
    }));
  }

  // Validate Dockerfile format
  validateDockerfile(parseResult) {
    const issues = [];

    try {
      // Check for FROM instruction
      if (!parseResult.fromInstructions || parseResult.fromInstructions.length === 0) {
        issues.push('No FROM instruction found');
      }

      // Check for valid base images
      let hasValidBaseImage = false;
      for (const fromInstr of parseResult.fromInstructions) {
        if (fromInstr.isBaseImage) {
          hasValidBaseImage = true;
          
          // Validate image name
          if (!fromInstr.image || fromInstr.image.trim() === '') {
            issues.push('Empty image name in FROM instruction');
          }
          
          // Validate tag
          if (!fromInstr.tag || fromInstr.tag.trim() === '') {
            issues.push('Missing tag in FROM instruction');
          }
        }
      }

      if (!hasValidBaseImage) {
        issues.push('No valid base image found');
      }

      // Check for common issues
      const content = parseResult.content.toLowerCase();
      if (content.includes('add http://') || content.includes('add https://')) {
        issues.push('Consider using COPY instead of ADD for URLs');
      }

      logger.debug('Dockerfile validation completed', {
        issuesFound: issues.length,
        issues
      });

      return {
        isValid: issues.length === 0,
        issues
      };

    } catch (error) {
      logger.error('Dockerfile validation failed', { error: error.message });
      return {
        isValid: false,
        issues: [`Validation error: ${error.message}`]
      };
    }
  }

  // Get OS family from image name
  getOSFamily(imageName) {
    const osMap = {
      'ubuntu': 'ubuntu',
      'debian': 'debian', 
      'alpine': 'alpine',
      'centos': 'centos',
      'rhel': 'rhel',
      'fedora': 'fedora',
      'amazonlinux': 'amazonlinux',
      'node': 'debian', // Node.js official images are based on Debian
      'python': 'debian', // Python official images are based on Debian
      'nginx': 'debian',
      'redis': 'debian',
      'postgres': 'debian',
      'mysql': 'debian'
    };

    const lowerImageName = imageName.toLowerCase();
    
    for (const [key, family] of Object.entries(osMap)) {
      if (lowerImageName.includes(key)) {
        return family;
      }
    }

    return 'unknown';
  }

  // Parse semantic version
  parseVersion(versionString) {
    try {
      const cleanVersion = versionString.replace(/[^0-9.]/g, '');
      const parts = cleanVersion.split('.').map(part => parseInt(part, 10));
      
      return {
        major: parts[0] || 0,
        minor: parts[1] || 0,
        patch: parts[2] || 0,
        original: versionString,
        semantic: cleanVersion
      };
    } catch (error) {
      logger.warn('Failed to parse version', { version: versionString });
      return {
        major: 0,
        minor: 0,
        patch: 0,
        original: versionString,
        semantic: versionString
      };
    }
  }
}

module.exports = DockerfileParser; 