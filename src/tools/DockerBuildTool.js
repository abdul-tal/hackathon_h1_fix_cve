const Docker = require('dockerode');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/config');
const logger = require('../utils/logger');

class DockerBuildTool {
  constructor() {
    // Configure Docker connection based on host type
    let dockerConfig = {};
    
    if (config.docker.host.startsWith('unix://')) {
      dockerConfig.socketPath = config.docker.host.replace('unix://', '');
    } else if (config.docker.host.startsWith('tcp://')) {
      const url = new URL(config.docker.host);
      dockerConfig.host = url.hostname;
      dockerConfig.port = url.port || 2376;
    } else {
      // Default to local Docker daemon
      dockerConfig.socketPath = '/var/run/docker.sock';
    }
    
    this.docker = new Docker(dockerConfig);
    this.buildTimeout = config.docker.buildTimeout;
    this.tempImages = new Set(); // Track temporary images for cleanup
  }

  // Build Docker image from Dockerfile
  async buildImage(dockerfilePath, options = {}) {
    const buildOptions = {
      imageName: options.imageName || this.generateImageName(),
      buildContext: options.buildContext || path.dirname(dockerfilePath),
      dockerfile: path.basename(dockerfilePath),
      buildArgs: options.buildArgs || {},
      labels: options.labels || {},
      platform: options.platform || 'linux/amd64',
      noCache: options.noCache || false,
      ...options
    };

    try {
      logger.info('Starting Docker build', {
        dockerfilePath,
        imageName: buildOptions.imageName,
        buildContext: buildOptions.buildContext
      });

      // Validate build context and Dockerfile
      await this.validateBuildContext(buildOptions.buildContext, buildOptions.dockerfile);

      // Create build stream
      const buildStream = await this.docker.buildImage({
        context: buildOptions.buildContext,
        src: [buildOptions.dockerfile]
      }, {
        t: buildOptions.imageName,
        dockerfile: buildOptions.dockerfile,
        buildargs: buildOptions.buildArgs,
        labels: buildOptions.labels,
        platform: buildOptions.platform,
        nocache: buildOptions.noCache,
        rm: true, // Remove intermediate containers
        forcerm: true // Always remove intermediate containers
      });

      // Monitor build process
      const buildResult = await this.monitorBuildStream(buildStream, buildOptions);

      // Validate that image was created
      const imageInfo = await this.validateBuild(buildOptions.imageName);

      // Track temporary image for cleanup
      this.tempImages.add(buildOptions.imageName);

      logger.info('Docker build completed successfully', {
        imageName: buildOptions.imageName,
        imageId: imageInfo.Id,
        size: imageInfo.Size
      });

      return {
        success: true,
        imageName: buildOptions.imageName,
        imageId: imageInfo.Id,
        size: imageInfo.Size,
        created: imageInfo.Created,
        logs: buildResult.logs,
        buildTime: buildResult.buildTime
      };

    } catch (error) {
      logger.error('Docker build failed', {
        dockerfilePath,
        imageName: buildOptions.imageName,
        error: error.message
      });

      throw new Error(`Docker build failed: ${error.message}`);
    }
  }

  // Validate build context and Dockerfile
  async validateBuildContext(buildContext, dockerfileName) {
    try {
      // Check if build context exists
      if (!await fs.pathExists(buildContext)) {
        throw new Error(`Build context directory not found: ${buildContext}`);
      }

      // Check if Dockerfile exists
      const dockerfilePath = path.join(buildContext, dockerfileName);
      if (!await fs.pathExists(dockerfilePath)) {
        throw new Error(`Dockerfile not found: ${dockerfilePath}`);
      }

      // Check if build context is readable
      const contextStats = await fs.stat(buildContext);
      if (!contextStats.isDirectory()) {
        throw new Error(`Build context is not a directory: ${buildContext}`);
      }

      logger.debug('Build context validation passed', {
        buildContext,
        dockerfileName
      });

    } catch (error) {
      logger.error('Build context validation failed', {
        buildContext,
        dockerfileName,
        error: error.message
      });
      throw error;
    }
  }

  // Monitor build stream and collect logs
  async monitorBuildStream(buildStream, buildOptions) {
    return new Promise((resolve, reject) => {
      const logs = [];
      const startTime = Date.now();
      let buildError = null;

      // Set timeout for build
      const timeout = setTimeout(() => {
        buildStream.destroy();
        reject(new Error(`Build timeout after ${this.buildTimeout}ms`));
      }, this.buildTimeout);

      // Parse build output
      this.docker.modem.followProgress(
        buildStream,
        (error, result) => {
          clearTimeout(timeout);
          
          if (error) {
            logger.error('Build stream error', {
              imageName: buildOptions.imageName,
              error: error.message
            });
            reject(error);
          } else if (buildError) {
            reject(new Error(buildError));
          } else {
            const buildTime = Date.now() - startTime;
            logger.debug('Build stream completed', {
              imageName: buildOptions.imageName,
              buildTime: `${buildTime}ms`,
              logLines: logs.length
            });
            
            resolve({
              logs,
              buildTime
            });
          }
        },
        (event) => {
          // Process build events
          if (event.stream) {
            const logLine = event.stream.trim();
            if (logLine) {
              logs.push({
                timestamp: new Date().toISOString(),
                message: logLine
              });
              
              logger.debug('Build output', {
                imageName: buildOptions.imageName,
                message: logLine
              });
            }
          }

          if (event.error) {
            buildError = event.error;
            logger.error('Build error event', {
              imageName: buildOptions.imageName,
              error: event.error
            });
          }

          if (event.errorDetail) {
            buildError = event.errorDetail.message || 'Unknown build error';
            logger.error('Build error detail', {
              imageName: buildOptions.imageName,
              errorDetail: event.errorDetail
            });
          }
        }
      );
    });
  }

  // Validate that image was built successfully
  async validateBuild(imageName) {
    try {
      logger.debug('Validating built image', { imageName });

      // Check if image exists
      const image = this.docker.getImage(imageName);
      const imageInfo = await image.inspect();

      // Basic validation
      if (!imageInfo.Id) {
        throw new Error('Image ID not found');
      }

      if (imageInfo.Size === 0) {
        logger.warn('Image size is 0 bytes', { imageName });
      }

      logger.debug('Image validation passed', {
        imageName,
        imageId: imageInfo.Id,
        size: imageInfo.Size,
        created: imageInfo.Created
      });

      return imageInfo;

    } catch (error) {
      logger.error('Image validation failed', {
        imageName,
        error: error.message
      });
      throw new Error(`Image validation failed: ${error.message}`);
    }
  }

  // Check if image exists
  async imageExists(imageName) {
    try {
      const image = this.docker.getImage(imageName);
      await image.inspect();
      return true;
    } catch (error) {
      if (error.statusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  // Get image information
  async getImageInfo(imageName) {
    try {
      const image = this.docker.getImage(imageName);
      const imageInfo = await image.inspect();
      
      return {
        id: imageInfo.Id,
        created: imageInfo.Created,
        size: imageInfo.Size,
        virtualSize: imageInfo.VirtualSize,
        architecture: imageInfo.Architecture,
        os: imageInfo.Os,
        config: imageInfo.Config,
        rootFS: imageInfo.RootFS
      };

    } catch (error) {
      logger.error('Failed to get image info', {
        imageName,
        error: error.message
      });
      throw new Error(`Failed to get image info: ${error.message}`);
    }
  }

  // Clean up temporary images
  async cleanupImages(imageNames = null) {
    const imagesToCleanup = imageNames || Array.from(this.tempImages);
    const results = [];

    logger.info('Cleaning up Docker images', {
      imageCount: imagesToCleanup.length
    });

    for (const imageName of imagesToCleanup) {
      try {
        const image = this.docker.getImage(imageName);
        await image.remove({ force: true });
        
        this.tempImages.delete(imageName);
        results.push({
          imageName,
          success: true
        });

        logger.debug('Image removed successfully', { imageName });

      } catch (error) {
        results.push({
          imageName,
          success: false,
          error: error.message
        });

        logger.warn('Failed to remove image', {
          imageName,
          error: error.message
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failureCount = results.length - successCount;

    logger.info('Image cleanup completed', {
      total: results.length,
      success: successCount,
      failed: failureCount
    });

    return {
      total: results.length,
      success: successCount,
      failed: failureCount,
      results
    };
  }

  // Generate unique image name for temporary builds
  generateImageName(prefix = 'cve-fix-temp') {
    const uuid = uuidv4().split('-')[0];
    const timestamp = Date.now().toString(36);
    return `${prefix}:${timestamp}-${uuid}`;
  }

  // Get Docker daemon info
  async getDockerInfo() {
    try {
      const info = await this.docker.info();
      const version = await this.docker.version();
      
      return {
        info: {
          containers: info.Containers,
          images: info.Images,
          serverVersion: info.ServerVersion,
          storageDriver: info.Driver,
          architecture: info.Architecture,
          operatingSystem: info.OperatingSystem
        },
        version: {
          version: version.Version,
          apiVersion: version.ApiVersion,
          gitCommit: version.GitCommit,
          buildTime: version.BuildTime
        }
      };

    } catch (error) {
      logger.error('Failed to get Docker info', {
        error: error.message
      });
      throw new Error(`Failed to get Docker info: ${error.message}`);
    }
  }

  // Check if Docker daemon is accessible
  async checkDockerAccess() {
    try {
      await this.docker.ping();
      logger.debug('Docker daemon is accessible');
      return true;
    } catch (error) {
      logger.error('Docker daemon not accessible', {
        error: error.message
      });
      throw new Error(`Docker daemon not accessible: ${error.message}`);
    }
  }

  // Get build logs in a formatted way
  formatBuildLogs(logs, options = {}) {
    const maxLines = options.maxLines || 100;
    const includeTimestamp = options.includeTimestamp !== false;
    
    const formattedLogs = logs
      .slice(-maxLines) // Get last N lines
      .map(log => {
        if (includeTimestamp && log.timestamp) {
          return `[${log.timestamp}] ${log.message}`;
        }
        return log.message || log;
      })
      .join('\n');

    return formattedLogs;
  }

  // Extract error information from build logs
  extractBuildErrors(logs) {
    const errors = [];
    const errorKeywords = [
      'ERROR', 'error:', 'Error:', 'FAILED', 'failed:', 'Failed:',
      'No such file', 'cannot find', 'not found', 'permission denied'
    ];

    for (const log of logs) {
      const message = log.message || log;
      
      for (const keyword of errorKeywords) {
        if (message.includes(keyword)) {
          errors.push({
            timestamp: log.timestamp,
            message: message.trim(),
            keyword
          });
          break;
        }
      }
    }

    return errors;
  }

  // Get disk usage for Docker
  async getDockerDiskUsage() {
    try {
      const usage = await this.docker.df();
      
      return {
        images: {
          count: usage.Images?.length || 0,
          size: usage.Images?.reduce((total, img) => total + (img.Size || 0), 0) || 0
        },
        containers: {
          count: usage.Containers?.length || 0,
          size: usage.Containers?.reduce((total, cont) => total + (cont.SizeRw || 0), 0) || 0
        },
        volumes: {
          count: usage.Volumes?.length || 0,
          size: usage.Volumes?.reduce((total, vol) => total + (vol.Size || 0), 0) || 0
        }
      };

    } catch (error) {
      logger.warn('Failed to get Docker disk usage', {
        error: error.message
      });
      return null;
    }
  }
}

module.exports = DockerBuildTool; 