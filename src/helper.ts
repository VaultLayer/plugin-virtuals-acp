import AcpClient, {
    AcpContractClientV2,
    baseAcpConfigV2,
} from "@virtuals-protocol/acp-node";
import { type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { JobTypeConfig } from "./types";

/**
 * Create an ACP Contract Client from configuration
 */
export async function createAcpContractClient(
    privateKey: Address,
    entityId: string,
    agentAddress: Address,
): Promise<AcpContractClientV2> {
    return await AcpContractClientV2.build(
        privateKey,
        entityId,
        agentAddress,
    );
}

/**
 * Get account address from private key
 */
export function getAccountFromPrivateKey(privateKey: Address): Address {
    const account = privateKeyToAccount(privateKey);
    return account.address;
}

/**
 * Get the ACP configuration (currently only V2 is supported)
 */
export function getAcpConfig() {
    return baseAcpConfigV2;
}

/**
 * Default job type registry
 * Can be extended by users to add custom job types
 */
export function createDefaultJobTypeRegistry(): Record<
    string,
    JobTypeConfig
> {
    return {
        // Add default job types here if needed
        // Example:
        // "default": {
        //     handlerType: "eliza",
        // },
    };
}

