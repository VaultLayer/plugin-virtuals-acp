/**
 * Eliza Handler Implementation for ACP
 * 
 * This handler processes general query jobs by integrating with Eliza's
 * runtime event system.
 */

import { AcpJob, AcpJobPhases, AcpMemo, DeliverablePayload } from "@virtuals-protocol/acp-node";
import { 
    logger, 
    type IAgentRuntime, 
    type Memory, 
    type Content,
    type HandlerCallback,
    EventType,
    ChannelType,
    createUniqueUuid,
    stringToUuid,
} from "@elizaos/core";

/**
 * The Eliza handler follows this flow:
 * 
 * 1. REQUEST phase (nextPhase = NEGOTIATION):
 *    - Check if Eliza can handle the job requirement
 *    - Accept and create requirement if capable
 *    - Reject if not capable
 * 
 * 2. TRANSACTION phase (nextPhase = EVALUATION):
 *    - Process the job with Eliza AI
 *    - Generate deliverable based on Eliza's response
 *    - Deliver or reject based on processing result
 */

/**
 * Example job requirement structure for general queries:
 */
export interface GeneralQueryRequirement {
    query: string;
    context?: Record<string, any>;
    expectedFormat?: "text" | "json" | "markdown";
}

/**
 * Example deliverable structure:
 */
export interface GeneralQueryDeliverable {
    type: "text" | "object";
    value: string | Record<string, any>;
    metadata?: {
        processedAt: string;
        tokensUsed?: number;
        model?: string;
    };
}

/**
 * Example: Custom capability checker
 * 
 * This function can be extended to check if Eliza can handle specific types of queries
 */
export function canHandleQuery(requirement: GeneralQueryRequirement): boolean {
    // Check if the query is within Eliza's capabilities
    const { query } = requirement;
    
    // Example: Reject queries that are too long
    if (query.length > 10000) {
        return false;
    }
    
    // Example: Reject specific types of queries
    const unsupportedKeywords = ["illegal", "harmful", "dangerous"];
    if (unsupportedKeywords.some(keyword => query.toLowerCase().includes(keyword))) {
        return false;
    }
    
    // Accept all other queries
    return true;
}

/**
 * Example: Process query with Eliza
 * 
 * This is handled automatically by the service, but you can customize
 * the deliverable format here
 */
export function formatElizaResponse(
    response: string,
    requirement: GeneralQueryRequirement
): DeliverablePayload {
    const expectedFormat = requirement.expectedFormat || "text";
    
    if (expectedFormat === "json") {
        try {
            const parsed = JSON.parse(response);
            return {
                type: "object",
                value: parsed,
                metadata: {
                    processedAt: new Date().toISOString(),
                },
            };
        } catch (error) {
            // If parsing fails, return as text
            logger.warn("Failed to parse response as JSON, returning as text");
        }
    }
    
    return {
        type: "text",
        value: response,
        metadata: {
            processedAt: new Date().toISOString(),
        },
    };
}

/**
 * Main handler for general query jobs - integrates with Eliza runtime
 */
export async function handleGeneralQuery(
    runtime: IAgentRuntime,
    job: AcpJob, 
    memoToSign?: AcpMemo
) {
    const { phase, id: jobId, clientAddress } = job;
    const requirement = job.requirement as GeneralQueryRequirement;
    
    // REQUEST phase - Check capability
    if (phase === AcpJobPhases.REQUEST && memoToSign?.nextPhase === AcpJobPhases.NEGOTIATION) {
        const canHandle = canHandleQuery(requirement);
        
        if (canHandle) {
            await job.accept("Job requirement matches agent capability");
            await job.createRequirement(
                `Job ${String(jobId)} accepted, please make payment to proceed`
            );
            logger.success(`[ACP Eliza] General query job ${String(jobId)} accepted`);
        } else {
            await job.reject("Job requirement does not meet agent capability");
            logger.warn(`[ACP Eliza] General query job ${String(jobId)} rejected`);
        }
        return;
    }
    
    // TRANSACTION phase - Process with Eliza through runtime event system
    if (phase === AcpJobPhases.TRANSACTION && memoToSign?.nextPhase === AcpJobPhases.EVALUATION) {
        try {
            logger.info(`[ACP Eliza] Processing query job ${String(jobId)} with Eliza`);
            
            // Create a unique room ID for this ACP conversation
            const roomId = stringToUuid(`acp-room-${String(jobId)}`);
            const messageId = stringToUuid(`acp-msg-${String(jobId)}`);
            const entityId = createUniqueUuid(runtime, clientAddress);
            
            // Create memory from ACP job details
            const memory: Memory = {
                id: createUniqueUuid(runtime, String(jobId)),
                entityId,
                agentId: runtime.agentId,
                roomId,
                content: {
                    text: requirement.query,
                    channelType: ChannelType.DM, // ACP is direct messaging
                    source: "acp",
                },
                metadata: {
                    type: "acp",
                    jobId: String(jobId),
                    clientAddress,
                    context: requirement.context,
                    expectedFormat: requirement.expectedFormat,
                    phase: AcpJobPhases[phase],
                },
            };
            
            // Store the incoming message
            await runtime.createMemory(memory, "messages");
            
            // Create callback to handle Eliza's response (similar to XMTP)
            const callback: HandlerCallback = async (
                content: Content,
                _files?: string[],
            ) => {
                try {
                    if (!content.text) {
                        logger.warn("[ACP Eliza] No text content in response");
                        return [];
                    }
                    
                    logger.info(`[ACP Eliza] Eliza response: ${content.text}`);
                    
                    // Format the response as deliverable
                    const deliverable = formatElizaResponse(content.text, requirement);
                    
                    // Deliver through ACP job
                    await job.deliver(deliverable);
                    logger.success(`[ACP Eliza] Job ${String(jobId)} delivered successfully`);
                    
                    // Create response memory
                    const responseMemory: Memory = {
                        id: createUniqueUuid(runtime, `${String(jobId)}-response`),
                        entityId: runtime.agentId,
                        agentId: runtime.agentId,
                        roomId,
                        content: {
                            ...content,
                            text: content.text,
                            inReplyTo: messageId,
                            channelType: ChannelType.DM,
                            source: "acp",
                        },
                        metadata: {
                            type: "acp",
                            jobId: String(jobId),
                            clientAddress,
                            delivered: true,
                        },
                    };
                    
                    await runtime.createMemory(responseMemory, "messages");
                    
                    return [responseMemory];
                } catch (error) {
                    logger.error("[ACP Eliza] Error in callback:", error);
                    await job.reject("Error processing response");
                    return [];
                }
            };
            
            // Emit MESSAGE_RECEIVED event to trigger Eliza processing
            runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
                runtime,
                message: memory,
                callback,
                source: "acp",
            });
            
        } catch (error) {
            logger.error(`[ACP Eliza] Error processing job ${String(jobId)}:`, error);
            await job.reject("Unable to process job requirement");
        }
        return;
    }
}

/**
 * Flow Diagram (Updated with Runtime Integration):
 * 
 * Client        ACP Service         Handler              Eliza Runtime
 *   |               |                  |                       |
 *   |--query------->|                  |                       |
 *   |  (REQUEST)    |                  |                       |
 *   |               |--Check---------->|                       |
 *   |               |  Capability      |                       |
 *   |               |<--Can Handle-----|                       |
 *   |               |                  |                       |
 *   |<--Accept------|                  |                       |
 *   |   & Require   |                  |                       |
 *   |               |                  |                       |
 *   |--Payment----->|                  |                       |
 *   | (TRANSACTION) |                  |                       |
 *   |               |--Process-------->|                       |
 *   |               |                  |--Create Memory------->|
 *   |               |                  |--Emit Event---------->|
 *   |               |                  |   MESSAGE_RECEIVED    |
 *   |               |                  |                       |
 *   |               |                  |                   [Process]
 *   |               |                  |                       |
 *   |               |                  |<--Callback(response)--|
 *   |               |                  |                       |
 *   |               |                  |--Deliver Result------>|
 *   |<--Response----|<--ACP Deliver----|                       |
 *   |               |                  |<--Store Memory--------|
 *   |               |                  |                       |
 * 
 * Key Steps:
 * - ACP messages are properly stored as Memory objects
 * - Eliza processes messages through the standard event system
 * - Responses are delivered back through the ACP job callback
 * - Full conversation history is maintained in the runtime
 */

