import type { AcpJob, AcpMemo } from "@virtuals-protocol/acp-node";

/**
 * Job handler type - determines routing strategy
 * - 'eliza': Route job to Eliza runtime for AI processing
 * - 'predetermined': Handle with predetermined function
 */
export type JobHandlerType = "eliza" | "predetermined";

/**
 * Configuration for a specific job type
 */
export interface JobTypeConfig {
    handlerType: JobHandlerType;
    handler?: (job: AcpJob, service: any, memoToSign?: AcpMemo) => Promise<void>;
}

/**
 * ACP Service configuration
 */
export interface AcpServiceConfig {
    jobTypeRegistry: Record<string, JobTypeConfig>;
}

/**
 * Job query parameters for pagination
 */
export interface JobQueryParams {
    page?: number;
    pageSize?: number;
}

