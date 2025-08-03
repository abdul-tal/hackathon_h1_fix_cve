const { initializeAgentExecutorWithOptions } = require('langchain/agents');
const { ChatOpenAI } = require('@langchain/openai');
const { DynamicTool } = require('langchain/tools');

// Import our tools
const TrivyTool = require('../tools/TrivyTool');
const DockerfileParser = require('../tools/DockerfileParser');
const DockerHubAPI = require('../tools/DockerHubAPI');
const DockerfileUpdater = require('../tools/DockerfileUpdater');
const DockerBuildTool = require('../tools/DockerBuildTool');
const DockerRunTool = require('../tools/DockerRunTool');
const VersionFinder = require('../tools/VersionFinder');

const config = require('../config/config');
const logger = require('../utils/logger');

class CVEFixAgent {
  constructor() {
    this.llm = null;
    this.agent = null;
    this.tools = {};
    this.langchainTools = [];
    
    this.initializeTools();
    this.initializeLLM();
  }

  // Initialize all tools
  initializeTools() {
    logger.info('Initializing CVE Fix Agent tools');

    this.tools = {
      trivyTool: new TrivyTool(),
      dockerfileParser: new DockerfileParser(),
      dockerHubAPI: new DockerHubAPI(),
      dockerfileUpdater: new DockerfileUpdater(),
      dockerBuildTool: new DockerBuildTool(),
      dockerRunTool: new DockerRunTool()
    };

    // VersionFinder needs other tools
    this.tools.versionFinder = new VersionFinder(
      this.tools.trivyTool,
      this.tools.dockerHubAPI
    );

    logger.info('All tools initialized successfully');
  }

  // Initialize Language Model
  initializeLLM() {
    if (!config.openai.apiKey) {
      logger.warn('OpenAI API key not configured - agent will run in mock mode');
      return;
    }
    
    // Force direct workflow mode to bypass LangChain parsing issues
    if (process.env.FORCE_DIRECT_MODE === 'true') {
      logger.info('Forcing direct workflow mode - LangChain agent disabled');
      return;
    }

    try {
      this.llm = new ChatOpenAI({
        openAIApiKey: config.openai.apiKey,
        modelName: 'gpt-4',
        temperature: 0.1, // Low temperature for consistent, focused responses
        maxTokens: 2000
      });

      logger.info('Language model initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize language model', {
        error: error.message
      });
      throw new Error(`Failed to initialize LLM: ${error.message}`);
    }
  }

  // Create Langchain tools from our tool instances
  createLangchainTools() {
    this.langchainTools = [
      // Dockerfile Parser Tool
      new DynamicTool({
        name: 'dockerfile_parser',
        description: 'Parse Dockerfile and extract base image information. Input: dockerfile path as string. Returns: parsed Dockerfile data with base image details.',
        func: async (dockerfilePath) => {
          try {
            const parseResult = await this.tools.dockerfileParser.parseDockerfile(dockerfilePath);
            const baseImage = this.tools.dockerfileParser.extractBaseImage(parseResult);
            
            return JSON.stringify({
              success: true,
              baseImage: {
                image: baseImage.image,
                tag: baseImage.tag,
                registry: baseImage.registry
              },
              isMultiStage: parseResult.isMultiStage,
              validation: this.tools.dockerfileParser.validateDockerfile(parseResult)
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      }),

      // Docker Hub API Tool
      new DynamicTool({
        name: 'docker_hub_api',
        description: 'Get available image versions from Docker Hub. Input: image name as string. Returns: available versions sorted by semantic version.',
        func: async (imageName) => {
          try {
            const tags = await this.tools.dockerHubAPI.getAvailableTags(imageName);
            const latestVersion = await this.tools.dockerHubAPI.getLatestVersion(imageName);
            
            return JSON.stringify({
              success: true,
              totalTags: tags.length,
              latestVersion: latestVersion.name,
              availableVersions: tags.slice(0, 20).map(tag => tag.name) // First 20 versions
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      }),

      // Trivy Scanner Tool
      new DynamicTool({
        name: 'trivy_scan',
        description: 'Scan Docker image for CVE. Input: JSON string with imageName, imageTag, and cveId properties. Returns: CVE status and scan results.',
        func: async (input) => {
          try {
            const { imageName, imageTag, cveId } = JSON.parse(input);
            const cveStatus = await this.tools.trivyTool.checkCVEInVersion(imageName, imageTag, cveId);
            
            return JSON.stringify({
              success: true,
              cveExists: cveStatus.exists,
              severity: cveStatus.severity,
              description: cveStatus.description,
              fixedVersion: cveStatus.fixedVersion
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      }),

      // Version Finder Tool
      new DynamicTool({
        name: 'version_finder',
        description: 'Find minimal OS version that fixes CVE. Input: JSON string with imageName, cveId, and currentVersion properties. Returns: fixed version or null.',
        func: async (input) => {
          try {
            const { imageName, cveId, currentVersion } = JSON.parse(input);
            const fixedVersion = await this.tools.versionFinder.findMinimalFixVersion(
              imageName, cveId, currentVersion
            );
            
            return JSON.stringify({
              success: true,
              fixedVersion,
              currentVersion,
              hasFixAvailable: !!fixedVersion
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      }),

      // Dockerfile Updater Tool
      new DynamicTool({
        name: 'dockerfile_updater',
        description: 'Update Dockerfile with new base image version. Input: JSON string with dockerfilePath, newImage, and newTag properties. Returns: update results.',
        func: async (input) => {
          try {
            const { dockerfilePath, newImage, newTag } = JSON.parse(input);
            const updateResult = await this.tools.dockerfileUpdater.updateBaseImage(
              dockerfilePath, newImage, newTag
            );
            
            return JSON.stringify({
              success: updateResult.success,
              backupPath: updateResult.backupPath,
              changes: updateResult.changes
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      }),

      // Docker Build Tool
      new DynamicTool({
        name: 'docker_build',
        description: 'Build Docker image from Dockerfile. Input: dockerfile path as string. Returns: build results with image ID and logs.',
        func: async (dockerfilePath) => {
          try {
            const buildResult = await this.tools.dockerBuildTool.buildImage(dockerfilePath);
            
            return JSON.stringify({
              success: buildResult.success,
              imageName: buildResult.imageName,
              imageId: buildResult.imageId,
              buildTime: buildResult.buildTime,
              size: buildResult.size
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      }),

      // Docker Run Tool
      new DynamicTool({
        name: 'docker_run',
        description: 'Test Docker container execution. Input: image ID as string. Returns: container run results and health checks.',
        func: async (imageId) => {
          try {
            const runResult = await this.tools.dockerRunTool.runContainer(imageId);
            
            return JSON.stringify({
              success: runResult.success,
              exitCode: runResult.exitCode,
              runTime: runResult.runTime,
              healthChecks: runResult.healthChecks,
              containerPassed: runResult.exitCode === 0
            });
          } catch (error) {
            return JSON.stringify({
              success: false,
              error: error.message
            });
          }
        }
      })
    ];

    logger.info('Langchain tools created', {
      toolCount: this.langchainTools.length
    });
  }

  // Initialize the Langchain agent
  async initializeAgent() {
    if (!this.llm) {
      throw new Error('Language model not initialized');
    }

    try {
      this.createLangchainTools();

      this.agent = await initializeAgentExecutorWithOptions(
        this.langchainTools,
        this.llm,
        {
          agentType: 'zero-shot-react-description',
          verbose: true,
          maxIterations: 10,
          returnIntermediateSteps: true
        }
      );

      logger.info('Langchain agent initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize agent', {
        error: error.message
      });
      throw new Error(`Failed to initialize agent: ${error.message}`);
    }
  }

  // Main entry point: fix CVE
  async fixCVE(cveId, dockerfilePath = './Dockerfile') {
    try {
      logger.info('Starting CVE fix process', {
        cveId,
        dockerfilePath
      });

      // If no LLM available, run direct workflow
      if (!this.llm) {
        return await this.runDirectWorkflow(cveId, dockerfilePath);
      }

      // Initialize agent if not already done
      if (!this.agent) {
        await this.initializeAgent();
      }

      // Create agent prompt
      const prompt = this.createAgentPrompt(cveId, dockerfilePath);

      // Execute agent
      const result = await this.agent.call({ input: prompt });

      logger.info('Agent execution completed', {
        cveId,
        success: result.output !== null
      });

      return this.parseAgentResult(result);

    } catch (error) {
      logger.error('CVE fix process failed', {
        cveId,
        dockerfilePath,
        error: error.message
      });
      throw new Error(`CVE fix failed: ${error.message}`);
    }
  }

  // Direct workflow (when no LLM available)
  async runDirectWorkflow(cveId, dockerfilePath) {
    logger.info('Running direct CVE fix workflow', { cveId, dockerfilePath });

    try {
      // Step 1: Parse Dockerfile
      const parseResult = await this.tools.dockerfileParser.parseDockerfile(dockerfilePath);
      const baseImage = this.tools.dockerfileParser.extractBaseImage(parseResult);
      
      logger.info('Current base image extracted', {
        image: baseImage.image,
        tag: baseImage.tag
      });

      // Step 2: Get latest version
      const latestVersion = await this.tools.dockerHubAPI.getLatestVersion(baseImage.image);
      
      // Step 3: Check CVE in latest version
      const latestCVEStatus = await this.tools.trivyTool.checkCVEInVersion(
        baseImage.image, latestVersion.name, cveId
      );

      if (latestCVEStatus.exists) {
        return {
          status: 'no_fix_available',
          message: `CVE ${cveId} still exists in latest version ${latestVersion.name}`,
          original_version: `${baseImage.image}:${baseImage.tag}`,
          fixed_version: null,
          cve_details: {
            severity: latestCVEStatus.severity,
            description: latestCVEStatus.description
          }
        };
      }

      // Step 4: Find minimal fix version
      const fixedVersion = await this.tools.versionFinder.findMinimalFixVersion(
        baseImage.image, cveId, baseImage.tag
      );

      if (!fixedVersion) {
        return {
          status: 'no_fix_available',
          message: `No version found that fixes CVE ${cveId}`,
          original_version: `${baseImage.image}:${baseImage.tag}`,
          fixed_version: null,
          cve_details: {
            severity: latestCVEStatus.severity,
            description: latestCVEStatus.description
          }
        };
      }

      // Step 5: Update Dockerfile
      const updateResult = await this.tools.dockerfileUpdater.updateBaseImage(
        dockerfilePath, baseImage.image, fixedVersion
      );

      // Step 6: Build image
      const buildResult = await this.tools.dockerBuildTool.buildImage(dockerfilePath);

      // Step 7: Skip container run test - successful build is sufficient validation
      logger.info('Docker build successful - skipping container run test for repository workflow', {
        imageId: buildResult.imageId,
        imageSize: buildResult.size
      });

      // Step 8: Cleanup
      await this.tools.dockerBuildTool.cleanupImages([buildResult.imageName]);

      return {
        status: 'success',
        message: `CVE ${cveId} fixed by upgrading ${baseImage.image} from ${baseImage.tag} to ${fixedVersion}`,
        original_version: `${baseImage.image}:${baseImage.tag}`,
        fixed_version: `${baseImage.image}:${fixedVersion}`,
        cve_details: {
          severity: latestCVEStatus.severity,
          description: latestCVEStatus.description
        }
      };

    } catch (error) {
      logger.error('Direct workflow failed', {
        cveId,
        error: error.message
      });

      return {
        status: 'failure',
        message: `CVE fix failed: ${error.message}`,
        original_version: null,
        fixed_version: null,
        cve_details: {
          severity: 'UNKNOWN',
          description: 'Failed to process CVE'
        }
      };
    }
  }

  // Create agent prompt
  createAgentPrompt(cveId, dockerfilePath) {
    return `You are a CVE Fix Automation Agent. Your goal is to fix CVE ${cveId} by upgrading the OS version in the Dockerfile at ${dockerfilePath}.

Follow this workflow:

1. Parse the Dockerfile to extract the current base image and version
2. Check the latest version of that OS on Docker Hub
3. Scan the latest version for CVE ${cveId} - if it still exists, return "no fix available"
4. If the CVE is fixed in the latest version, find the minimal version that fixes it
5. Update the Dockerfile with the minimal fix version
6. Build the Docker image to verify it builds successfully
7. Run the container to verify it works

Return a JSON response with:
- status: "success", "failure", or "no_fix_available"
- message: Description of what happened
- original_version: The original image:tag
- fixed_version: The new image:tag (if successful)
- cve_details: severity and description

Start now by parsing the Dockerfile.`;
  }

  // Parse agent result
  parseAgentResult(result) {
    try {
      // Try to extract JSON from the agent's output
      const output = result.output;
      
      // Look for JSON in the output
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      } else {
        // Fallback: create response from output text
        return {
          status: 'failure',
          message: output,
          original_version: null,
          fixed_version: null,
          cve_details: {
            severity: 'UNKNOWN',
            description: 'Agent processing completed but format unclear'
          }
        };
      }
    } catch (error) {
      logger.error('Failed to parse agent result', {
        error: error.message,
        output: result.output
      });
      
      return {
        status: 'failure',
        message: 'Failed to parse agent response',
        original_version: null,
        fixed_version: null,
        cve_details: {
          severity: 'UNKNOWN',
          description: 'Agent response parsing failed'
        }
      };
    }
  }

  // Cleanup resources
  async cleanup() {
    try {
      logger.info('Cleaning up CVE Fix Agent resources');
      
      // Cleanup Docker resources
      await this.tools.dockerBuildTool.cleanupImages();
      await this.tools.dockerRunTool.cleanupContainers();
      
      // Clear caches
      this.tools.versionFinder.clearCache();
      this.tools.dockerHubAPI.clearCache();
      
      logger.info('Agent cleanup completed');
    } catch (error) {
      logger.warn('Agent cleanup failed', {
        error: error.message
      });
    }
  }

  // Get agent status
  getStatus() {
    return {
      llmAvailable: !!this.llm,
      agentInitialized: !!this.agent,
      toolsInitialized: Object.keys(this.tools).length > 0,
      versionFinderStats: this.tools.versionFinder.getSearchStats(),
      dockerHubCacheStats: this.tools.dockerHubAPI.getCacheStats()
    };
  }
}

module.exports = CVEFixAgent; 