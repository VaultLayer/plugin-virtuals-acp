import {
    ChannelType,
    Content,
    createUniqueUuid,
    elizaLogger,
    EventType,
    HandlerCallback,
    IAgentRuntime,
    logger,
    Memory,
    Service,
    stringToUuid,
} from "@elizaos/core";
import AcpClient, {
    AcpJob,
    AcpJobPhases,
    AcpMemo,
    MemoType,
} from "@virtuals-protocol/acp-node";
import { type Address } from "viem";
import {
    createAcpContractClient,
    createDefaultJobTypeRegistry,
    getAcpConfig,
} from "./helper";
import type { AcpServiceConfig, JobQueryParams } from "./types";

export const ACP_SERVICE_NAME = "virtuals-acp";

export class AcpService extends Service {
    static serviceType = ACP_SERVICE_NAME;

    capabilityDescription =
        "The agent is able to send and receive jobs using Virtuals ACP (Agent Communication Protocol).";

    private client: AcpClient;
    private jobConfig: AcpServiceConfig;

    constructor(runtime: IAgentRuntime, config?: Partial<AcpServiceConfig>) {
        super(runtime);
        this.jobConfig = {
            jobTypeRegistry: {
                ...createDefaultJobTypeRegistry(),
                ...(config?.jobTypeRegistry || {}),
            },
        };
    }

    static async start(
        runtime: IAgentRuntime,
        config?: Partial<AcpServiceConfig>,
    ): Promise<Service> {
        logger.log("Constructing new AcpService...");

        const service = new AcpService(runtime, config);

        try {
            await service.setupClientWithRetry();
            logger.success("✅✅✅ ACP service started successfully");
        } catch (error) {
            logger.error("❌❌❌Failed to start ACP service:", error);
            throw new Error(
                `Failed to register service ${ACP_SERVICE_NAME}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        return service;
    }

    static async stop(_runtime: IAgentRuntime): Promise<void> {}

    stop(): Promise<void> {
        return Promise.resolve();
    }

    private async setupClient() {
        const privateKey = this.runtime.getSetting(
            "ACP_WALLET_PRIVATE_KEY",
        ) as Address;
        const entityId = this.runtime.getSetting("ACP_ENTITY_ID");
        const agentAddress = this.runtime.getSetting(
            "ACP_AGENT_WALLET_ADDRESS",
        ) as Address;

        if (!privateKey) {
            throw new Error("ACP_WALLET_PRIVATE_KEY is required");
        }

        if (!entityId) {
            throw new Error("ACP_ENTITY_ID is required");
        }

        if (!agentAddress) {
            throw new Error("ACP_AGENT_WALLET_ADDRESS is required");
        }

        const acpContractClient = await createAcpContractClient(
            privateKey,
            entityId,
            agentAddress,
        );

        this.client = new (AcpClient as any)({
            acpContractClient,
            onNewTask: this.handleNewTask.bind(this),
        }) as AcpClient;

        logger.success("ACP client created successfully");
    }

    private async setupClientWithRetry(maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await this.setupClient();
                logger.info("ACP client connected successfully");
                return;
            } catch (error) {
                logger.error(
                    `ACP client connection attempt ${i + 1} failed:`,
                    error,
                );

                if (i < maxRetries - 1) {
                    const delay = Math.pow(2, i) * 1000; // Exponential backoff
                    logger.info(`Retrying in ${delay}ms...`);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                } else {
                    throw error;
                }
            }
        }
    }

    /**
     * Handle new ACP tasks/jobs
     */
    private async handleNewTask(job: AcpJob, memoToSign?: AcpMemo) {
        const { id: jobId, phase: jobPhase, name: jobName } = job;

        logger.info(
            `🔍 [SERVICE DEBUG] onNewTask called - jobId: ${String(jobId)}, phase: ${AcpJobPhases[jobPhase]}, jobName: ${String(jobName)}, memoId: ${String(memoToSign?.id)}, nextPhase: ${memoToSign?.nextPhase ? AcpJobPhases[memoToSign.nextPhase] : 'undefined'}, memoType: ${memoToSign?.type}, content: ${memoToSign?.content}`,
        );
        const account = await this.getAccountByJobId(String(jobId));
        logger.info(`[DCA DEBUG] job Account: ${account}`)

        // Get job type configuration
        const jobTypeConfig = jobName
            ? this.jobConfig.jobTypeRegistry[jobName]
            : null;

        if (!jobTypeConfig) {
            // No configuration found - log warning
            logger.warn(
                `[handleNewTask] No configuration found for job type: ${jobName}`,
            );
            return;
        }

        // Route based on handler type
        if (jobTypeConfig.handlerType === "predetermined") {
            // Call predetermined handler
            if (jobTypeConfig.handler) {
                try {
                    await jobTypeConfig.handler(job, this, memoToSign);
                } catch (error) {
                    logger.error(
                        `[handleNewTask] Error in predetermined handler for ${jobName}:`,
                        error,
                    );
                }
            } else {
                logger.warn(
                    `[handleNewTask] No handler function provided for predetermined job type: ${jobName}`,
                );
            }
        } else if (jobTypeConfig.handlerType === "eliza") {
            // Route to Eliza runtime
            await this.processJobWithEliza(job, memoToSign);
        }
    }

    /**
     * Process job with Eliza runtime
     */
    private async processJobWithEliza(job: AcpJob, memoToSign?: AcpMemo) {
        try {
            const { id: jobId, phase: jobPhase, name: jobName } = job;
            const jobIdStr = String(jobId);

            // Handle REQUEST phase with NEGOTIATION
            if (
                jobPhase === AcpJobPhases.REQUEST &&
                memoToSign?.nextPhase === AcpJobPhases.NEGOTIATION
            ) {
                logger.info(
                    `[Eliza ACP] REQUEST phase for job ${jobIdStr}, routing to Eliza for capability check`,
                );

                // Check if Eliza can handle this job
                const canHandle = await this.checkElizaCapability(job);

                if (canHandle) {
                    await job.accept("Job requirement matches agent capability");
                    await job.createRequirement(
                        `Job ${jobIdStr} accepted, please make payment to proceed`,
                    );
                    logger.success(
                        `[Eliza ACP] Job ${jobIdStr} accepted and requirement created`,
                    );
                } else {
                    await job.reject("Job requirement does not meet agent capability");
                    logger.warn(`[Eliza ACP] Job ${jobIdStr} rejected by capability check`);
                }
                return;
            }

            // Handle TRANSACTION phase with EVALUATION
            if (
                jobPhase === AcpJobPhases.TRANSACTION &&
                memoToSign?.nextPhase === AcpJobPhases.EVALUATION
            ) {
                logger.info(
                    `[Eliza ACP] TRANSACTION phase for job ${jobIdStr}, processing with Eliza`,
                );

                // Process with Eliza and get deliverable
                const deliverable = await this.processJobWithElizaAI(job, memoToSign);

                if (deliverable) {
                    await job.deliver(deliverable);
                    logger.success(`[Eliza ACP] Job ${jobIdStr} delivered`);
                } else {
                    await job.reject("Unable to process job requirement");
                    logger.error(`[Eliza ACP] Job ${jobIdStr} rejected - no deliverable`);
                }
                return;
            }

            // Fallback: handle other phases or missing nextPhase
            logger.warn(
                `[Eliza ACP] Unhandled phase combination for job ${jobIdStr}: phase=${AcpJobPhases[jobPhase]}, nextPhase=${memoToSign?.nextPhase ? AcpJobPhases[memoToSign.nextPhase] : "undefined"}`,
            );
        } catch (error) {
            elizaLogger.error("Error in processJobWithEliza", error);
        }
    }

    /**
     * Check if Eliza can handle the job requirement
     */
    private async checkElizaCapability(job: AcpJob): Promise<boolean> {
        // Simple capability check - can be extended
        // For now, accept all jobs routed to Eliza
        return true;
    }

    /**
     * Process job with Eliza AI and return deliverable
     */
    private async processJobWithElizaAI(
        job: AcpJob,
        memoToSign?: AcpMemo,
    ): Promise<any> {
        const { id: jobId, name: jobName } = job;
        const jobIdStr = String(jobId);

        const entityId = createUniqueUuid(
            this.runtime,
            job.clientAddress || jobIdStr,
        );
        const messageId = stringToUuid(String(memoToSign?.id || jobId));
        const userId = stringToUuid(job.clientAddress || jobIdStr);
        const roomId = stringToUuid(jobIdStr);

        // Prepare job content for Eliza
        const jobContent = JSON.stringify({
            jobId: jobIdStr,
            jobName: String(jobName),
            requirement: job.requirement,
            clientAddress: job.clientAddress,
        });

        await this.runtime.ensureConnection({
            entityId,
            userName: job.clientAddress || jobIdStr,
            userId,
            roomId,
            channelId: jobIdStr,
            serverId: jobIdStr,
            source: "acp",
            type: ChannelType.DM,
            worldId: roomId,
        });

        const content: Content = {
            text: jobContent,
            source: "acp",
            inReplyTo: undefined,
        };

        const memory: Memory = {
            id: messageId,
            entityId,
            agentId: this.runtime.agentId,
            roomId,
            content,
            metadata: {
                type: "acp",
                jobId: jobIdStr,
                jobName: String(jobName),
                requirement: job.requirement,
                clientAddress: job.clientAddress,
            },
        };

        // Return a promise that resolves with the deliverable
        return new Promise((resolve) => {
            const callback: HandlerCallback = async (
                content: Content,
                _files?: string[],
            ) => {
                try {
                    if (!content.text) {
                        resolve(null);
                        return [];
                    }

                    // Create deliverable from Eliza's response
                    const deliverable = {
                        type: "text",
                        value: content.text,
                    };

                    const responseMemory: Memory = {
                        id: createUniqueUuid(this.runtime, `${jobIdStr}-response`),
                        entityId: this.runtime.agentId,
                        agentId: this.runtime.agentId,
                        roomId,
                        content: {
                            ...content,
                            text: content.text,
                            inReplyTo: messageId,
                            channelType: ChannelType.DM,
                        },
                        metadata: {
                            type: "acp",
                            jobId: jobIdStr,
                            delivered: true,
                        },
                    };

                    await this.runtime.createMemory(responseMemory, "messages");

                    resolve(deliverable);
                    return [responseMemory];
                } catch (error) {
                    elizaLogger.error("Error in Eliza callback", error);
                    resolve(null);
                }
            };

            this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
                runtime: this.runtime,
                message: memory,
                callback,
                source: "acp",
            });
        });
    }

    /**
     * Get active jobs with pagination
     */
    async getActiveJobs(
        page?: number,
        pageSize?: number,
    ): Promise<AcpJob[]> {
        try {
            return await this.client.getActiveJobs(page, pageSize);
        } catch (error) {
            logger.error("Error getting active jobs:", error);
            throw error;
        }
    }

    /**
     * Get completed jobs with pagination
     */
    async getCompletedJobs(
        page?: number,
        pageSize?: number,
    ): Promise<AcpJob[]> {
        try {
            return await this.client.getCompletedJobs(page, pageSize);
        } catch (error) {
            logger.error("Error getting completed jobs:", error);
            throw error;
        }
    }

    /**
     * Get cancelled jobs with pagination
     */
    async getCancelledJobs(
        page?: number,
        pageSize?: number,
    ): Promise<AcpJob[]> {
        try {
            return await this.client.getCancelledJobs(page, pageSize);
        } catch (error) {
            logger.error("Error getting cancelled jobs:", error);
            throw error;
        }
    }

    /**
     * Get jobs with pending memos with pagination
     */
    async getPendingMemoJobs(
        page?: number,
        pageSize?: number,
    ): Promise<AcpJob[]> {
        try {
            return await this.client.getPendingMemoJobs(page, pageSize);
        } catch (error) {
            logger.error("Error getting pending memo jobs:", error);
            throw error;
        }
    }

    /**
     * Get a specific job by ID
     */
    async getJobById(jobId: string): Promise<AcpJob | null> {
        try {
            return await this.client.getJobById(Number(jobId));
        } catch (error) {
            logger.error("Error getting job by ID:", error);
            throw error;
        }
    }


    /**
     * Get a specific memo by ID
     */
    async getMemoById(jobId: string, memoId: string): Promise<AcpMemo | null> {
        try {
            return await this.client.getMemoById(Number(jobId), Number(memoId));
        } catch (error) {
            logger.error("Error getting memo by ID:", error);
            throw error;
        }
    }

    /**
     * Create a notification for a job
     */
    async createNotification(
        jobId: string,
        content: string,
    ): Promise<string | null> {
        try {
            const job = await this.getJobById(jobId);
            if (!job) {
                logger.error(`Job not found: ${jobId}`);
                return null;
            }

            const createNotificationFn = (job as any)?.createNotification;
            if (typeof createNotificationFn !== "function") {
                logger.warn("[AcpService] createNotification method is not available on AcpJob");
                return null;
            }

            const memoId = await createNotificationFn.call(job, content);
            return memoId ? String(memoId) : null;
        } catch (error) {
            logger.error("Error creating notification:", error);
            throw error;
        }
    }

    /**
     * Get account by job ID
     */
    async getAccountByJobId(jobId: string): Promise<any> {
        try {
            return await this.client.getAccountByJobId(Number(jobId));
        } catch (error) {
            logger.error("Error getting account by job ID:", error);
            throw error;
        }
    }

    /**
     * Get account by client and provider addresses
     */
    async getByClientAndProvider(
        clientAddress: Address,
        providerAddress: Address,
    ): Promise<any> {
        try {
            return await this.client.getByClientAndProvider(
                clientAddress,
                providerAddress,
            );
        } catch (error) {
            logger.error("Error getting account by addresses:", error);
            throw error;
        }
    }

    /**
     * Update job type registry configuration
     */
    updateJobTypeRegistry(registry: Record<string, any>) {
        this.jobConfig.jobTypeRegistry = {
            ...this.jobConfig.jobTypeRegistry,
            ...registry,
        };
        logger.info("Job type registry updated");
    }
}

