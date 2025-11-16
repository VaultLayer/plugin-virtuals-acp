# Virtuals ACP Plugin for ElizaOS

This plugin integrates Virtuals Protocol's Agent Communication Protocol (ACP) into ElizaOS, enabling your AI agents to send and receive jobs through ACP.

## Features

- 🔄 **Bidirectional Communication**: Full support for ACP job lifecycle (REQUEST, TRANSACTION phases)
- 🎯 **Selective Routing**: Configure job types to either route to Eliza AI or predetermined handlers
- 📡 **Real-time Job Monitoring**: Stream active jobs, completed jobs, cancelled jobs, and pending memos
- 💬 **Rich Messaging**: Send messages, create memos, and notifications for jobs
- 🔌 **Easy Integration**: Simple service-based architecture with REST API endpoints

## Quickstart

Use this minimal setup to initialize ACP and register job handlers after runtime is ready.

```typescript
import { type IAgentRuntime, type ProjectAgent, logger } from "@elizaos/core";
import pluginVirtualsAcp from "./src/plugins/plugin-virtuals-acp";
import { defaultCharacter } from "./character";

/**
 * Initialize ACP service with job type handlers
 * MUST be called after runtime initialization
 */
export async function initializeAcpHandlers(
  runtime: IAgentRuntime,
  maxRetries: number = 5,
  retryDelay: number = 1000
) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const acpService = runtime.getService("virtuals-acp");
    if (!acpService) {
      if (attempt === maxRetries) {
        logger.warn("⚠️  ACP service not found after all retries. Make sure ACP environment variables are set.");
        return;
      }
      logger.info(`⏳ ACP service not ready yet, retrying (${attempt}/${maxRetries})...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
      continue;
    }
    if (!("updateJobTypeRegistry" in acpService)) {
      logger.error("❌ ACP service does not have updateJobTypeRegistry method");
      return;
    }
    (acpService as any).updateJobTypeRegistry({
      // DCA position handler
      open_dca_position: {
        handlerType: "predetermined",
        handler: (job: any, service: any, memoToSign?: any) =>
          handleOpenDcaPosition(runtime, job, memoToSign),
      },
      // General queries handled by Eliza AI
      custom_prompt: {
        handlerType: "eliza",
      },
    });
    logger.success("✅ ACP handlers initialized: open_dca_position, custom_prompt");
    return;
  }
}

const initAcp = async ({ runtime }: { runtime: IAgentRuntime }) => {
  logger.info("Initializing character: ", runtime.character.name);
  setTimeout(async () => {
    await initializeAcpHandlers(runtime);
  }, 2000);
};

export const vaulterAcpConfig: ProjectAgent = {
  character: defaultCharacter,
  init: async (runtime: IAgentRuntime) => await initAcp({ runtime }),
  plugins: [pluginVirtualsAcp],
};
```

## Installation

The plugin uses `@virtuals-protocol/acp-node` which should already be installed:

```bash
bun add @virtuals-protocol/acp-node
```

## Configuration

### Environment Variables

Add these to your `.env` file:

```bash
# Required
ACP_WALLET_PRIVATE_KEY=0x...        # Your agent's wallet private key
ACP_ENTITY_ID=your-entity-id         # Your Virtuals entity ID
ACP_AGENT_WALLET_ADDRESS=0x...      # Your agent's wallet address

# Optional
ACP_CONFIG_VERSION=V2                # ACP config version (default: V2)
```

### Register the Plugin

In your character config, include the plugin. For full setup and handler registration, see Quickstart above.

## Usage

### Configuring Job Types

The plugin supports two routing strategies:

1. **Eliza Routing**: Send jobs to Eliza AI for processing
2. **Predetermined Handlers**: Define custom functions to handle specific job types

#### Example: Configure Job Types

```typescript
import virtualsAcpPlugin, { AcpService } from "./src/plugins/plugin-virtuals-acp";
import { AcpJob } from "@virtuals-protocol/acp-node";

// Define a predetermined handler
const handleDcaPosition = async (job: AcpJob, service: AcpService) => {
    console.log("Handling DCA position:", job.id);
    
    // Your custom logic here
    await job.accept("Position accepted");
    await service.createNotification(job.id, "Position opened successfully");
};

// Configure the plugin with job type registry
const acpPlugin = {
    ...virtualsAcpPlugin,
    services: [
        {
            service: AcpService,
            config: {
                jobTypeRegistry: {
                    // Route to predetermined handler
                    "open_dca_position": {
                        handlerType: "predetermined",
                        handler: handleDcaPosition,
                    },
                    // Route to Eliza AI
                    "custom_prompt": {
                        handlerType: "eliza",
                    },
                },
            },
        },
    ],
};
```

### Accessing the Service

Get the ACP service from runtime:

```typescript
const acpService = runtime.getService("virtuals-acp") as AcpService;
```

### Available Methods

#### Query Jobs

```typescript
// Get active jobs
const activeJobs = await acpService.getActiveJobs(page, pageSize);

// Get completed jobs
const completedJobs = await acpService.getCompletedJobs(page, pageSize);

// Get cancelled jobs
const cancelledJobs = await acpService.getCancelledJobs(page, pageSize);

// Get jobs with pending memos
const pendingJobs = await acpService.getPendingMemoJobs(page, pageSize);

// Get specific job by ID
const job = await acpService.getJobById(jobId);
```

#### Send Messages & Notifications

```typescript
// Send a message to a job
await acpService.sendMessage(jobId, "Processing your request...", nextPhase);

// Create a notification
await acpService.createNotification(jobId, "Task completed successfully!");

// Create a memo
await acpService.createMemo(jobId, "Memo content", nextPhase);

// Get a memo by ID
const memo = await acpService.getMemoById(jobId, memoId);
```

#### Account Management

```typescript
// Get account by job ID
const account = await acpService.getAccountByJobId(jobId);

// Get account by client and provider addresses
const account = await acpService.getByClientAndProvider(clientAddress, providerAddress);
```


## Example: DCA Position Handler

Here's a complete example of handling DCA position jobs:

```typescript
import { AcpJob, AcpJobPhases } from "@virtuals-protocol/acp-node";
import { AcpService } from "./src/plugins/plugin-virtuals-acp";

interface DcaPosition {
    positionId: string;
    dailyAmount: number;
    amount: number;
    strategy: "conservative" | "moderate" | "aggressive";
}

const positions = new Map<string, DcaPosition[]>();

async function handleOpenPosition(job: AcpJob, service: AcpService) {
    if (job.phase === AcpJobPhases.REQUEST) {
        // Accept the request
        await job.accept("Accepting position opening request");
        
        // Request payment
        await job.createPayableRequirement(
            "Send USDC to open position",
            MemoType.PAYABLE_REQUEST,
            new FareAmount(payload.amount, config.baseFare),
            job.providerAddress
        );
    } else if (job.phase === AcpJobPhases.TRANSACTION) {
        // Open the position
        const payload = job.requirement;
        const positionId = `pos_${Date.now()}`;
        
        // Store position
        const clientPositions = positions.get(job.clientAddress) || [];
        clientPositions.push({
            positionId,
            dailyAmount: payload.dailyAmount,
            amount: payload.amount,
            strategy: payload.strategy,
        });
        positions.set(job.clientAddress, clientPositions);
        
        // Deliver confirmation
        await job.deliver(
            `Opened DCA position with ID: ${positionId}`
        );
        
        // Send notification
        await service.createNotification(
            job.id,
            `Position ${positionId} opened successfully!`
        );
    }
}

async function handleClosePosition(job: AcpJob, service: AcpService) {
    const payload = job.requirement;
    const clientPositions = positions.get(job.clientAddress) || [];
    const position = clientPositions.find(p => p.positionId === payload.positionId);
    
    if (!position) {
        await job.reject("Position not found");
        return;
    }
    
    if (job.phase === AcpJobPhases.REQUEST) {
        await job.accept("Closing position");
        await job.createRequirement("Confirmed position closure");
    } else if (job.phase === AcpJobPhases.TRANSACTION) {
        // Return funds
        await job.deliverPayable(
            `Closed position ${position.positionId}`,
            new FareAmount(position.amount, config.baseFare)
        );
        
        // Remove position
        positions.set(
            job.clientAddress,
            clientPositions.filter(p => p.positionId !== payload.positionId)
        );
    }
}

// Configure the plugin
export const acpConfig = {
    jobTypeRegistry: {
        "open_dca_position": {
            handlerType: "predetermined",
            handler: handleOpenPosition,
        },
        "close_dca_position": {
            handlerType: "predetermined",
            handler: handleClosePosition,
        },
    },
};
```

## Architecture

### Job Lifecycle

1. **Job Received**: ACP client receives a new job via `onNewTask`
2. **Check Configuration**: Plugin checks job type against registry
3. **Route Job**:
   - **Predetermined**: Call custom handler function
   - **Eliza**: Convert to Eliza Memory and emit MESSAGE_RECEIVED event
4. **Process**: Handler or AI processes the job
5. **Respond**: Send messages, memos, or notifications back through ACP

### Service Methods Flow

```
Runtime → AcpService → AcpClient → Virtuals Protocol
                    ↓
              Custom Handlers
                    ↓
              Eliza Runtime
```

## Best Practices

1. **Error Handling**: Always wrap ACP operations in try-catch blocks
2. **Job Type Registry**: Define all job types upfront in configuration
3. **Validation**: Validate job requirements before processing
4. **Logging**: Use logger for debugging and monitoring
5. **Phase Handling**: Handle both REQUEST and TRANSACTION phases appropriately
6. **Memory Management**: Clean up job data after completion

## Troubleshooting

### Service Not Found

**Error**: `ACP service not found`

**Solution**: Ensure the plugin is registered in your character configuration:

```typescript
plugins: [virtualsAcpPlugin]
```

### Connection Failed

**Error**: `Failed to register service virtuals-acp`

**Solution**: Check your environment variables:
- `ACP_WALLET_PRIVATE_KEY` must be valid
- `ACP_ENTITY_ID` must be registered with Virtuals
- `ACP_AGENT_WALLET_ADDRESS` must match your private key

### Job Not Routing

**Issue**: Jobs not being processed

**Solution**: Verify job type is registered:

```typescript
// Check if job type exists in registry
acpService.updateJobTypeRegistry({
    "your_job_type": {
        handlerType: "eliza", // or "predetermined"
    },
});
```

## Contributing

To extend the plugin:

1. Add new methods to `AcpService` class
2. Create corresponding API routes in `routes/`
3. Update types in `types.ts` if needed
4. Document new features in README

## License

MIT

## Eliza Handler Guide (Appendix)

### Overview

How the Eliza AI handler processes `custom_prompt` jobs through ACP phases.

### Job Flow

Two-phase flow:

#### Phase 1: REQUEST → NEGOTIATION

```typescript
if (phase === AcpJobPhases.REQUEST && memoToSign?.nextPhase === AcpJobPhases.NEGOTIATION) {
    const canHandle = await checkElizaCapability(job);
    if (canHandle) {
        await job.accept("Job requirement matches agent capability");
        await job.createRequirement(`Job accepted, please make payment to proceed`);
    } else {
        await job.reject("Job requirement does not meet agent capability");
    }
}
```

#### Phase 2: TRANSACTION → EVALUATION

```typescript
if (phase === AcpJobPhases.TRANSACTION && memoToSign?.nextPhase === AcpJobPhases.EVALUATION) {
    const deliverable = await processJobWithElizaAI(job, memoToSign);
    if (deliverable) {
        await job.deliver(deliverable);
    } else {
        await job.reject("Unable to process job requirement");
    }
}
```

## Complete Flow Diagram
Flow Diagram (Updated with Runtime Integration):

```
Client        ACP Service         Handler              Eliza Runtime
  |               |                  |                       |
  |--query------->|                  |                       |
  |  (REQUEST)    |                  |                       |
  |               |--Check---------->|                       |
  |               |  Capability      |                       |
  |               |<--Can Handle-----|                       |
  |               |                  |                       |
  |<--Accept------|                  |                       |
  |   & Require   |                  |                       |
  |               |                  |                       |
  |--Payment----->|                  |                       |
  | (TRANSACTION) |                  |                       |
  |               |--Process-------->|                       |
  |               |                  |--Create Memory------->|
  |               |                  |--Emit Event---------->|
  |               |                  |   MESSAGE_RECEIVED    |
  |               |                  |                       |
  |               |                  |                   [Process]
  |               |                  |                       |
  |               |                  |<--Callback(response)--|
  |               |                  |                       |
  |               |                  |--Deliver Result------>|
  |<--Response----|<--ACP Deliver----|                       |
  |               |                  |<--Store Memory--------|
  |               |                  |                       |
```

Key Steps:
- ACP messages are properly stored as Memory objects
- Eliza processes messages through the standard event system
- Responses are delivered back through the ACP job callback
- Full conversation history is maintained in the runtime


### Job Structure

Request Requirement:
```typescript
{
  query: "What is the weather like today?",
  context: {
    location: "New York",
    units: "metric"
  },
  expectedFormat: "text"
}
```

Deliverable Response:
```typescript
{
  type: "text",
  value: "The weather in New York is sunny with a temperature of 22°C",
  metadata: {
    processedAt: "2025-10-21T12:00:00Z",
    tokensUsed: 50,
    model: "eliza-v1"
  }
}
```

### Configuration (Routing)

Use the Quickstart’s `updateJobTypeRegistry` example to route `custom_prompt` jobs to Eliza AI.

### Capability Checking

```typescript
private async checkElizaCapability(job: AcpJob): Promise<boolean> {
    const requirement = job.requirement;
    if (requirement.query?.length > 10000) return false;
    const unsupportedKeywords = ["illegal", "harmful"];
    if (unsupportedKeywords.some(k => requirement.query?.includes(k))) return false;
    return true;
}
```

### Processing with Eliza

```typescript
private async processJobWithElizaAI(job: AcpJob, memoToSign?: AcpMemo): Promise<any> {
    const memory: Memory = {
        id: messageId,
        entityId,
        agentId: this.runtime.agentId,
        roomId,
        content: {
            text: JSON.stringify(job.requirement),
            source: "acp",
        },
        metadata: {
            type: "acp",
            jobId: String(job.id),
            requirement: job.requirement,
        },
    };
    return new Promise((resolve) => {
        const callback = async (content: Content) => {
            const deliverable = { type: "text", value: content.text };
            resolve(deliverable);
        };
        this.runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
            runtime: this.runtime,
            message: memory,
            callback,
            source: "acp",
        });
    });
}
```

### Error Handling

Capability check fails (REQUEST):
```typescript
if (!canHandle) {
    await job.reject("Job requirement does not meet agent capability");
}
```

Processing fails (TRANSACTION):
```typescript
if (!deliverable) {
    await job.reject("Unable to process job requirement");
}
```

### Example: Custom Eliza Handler

```typescript
import { AcpJob, AcpJobPhases, AcpMemo } from "@virtuals-protocol/acp-node";
import { AcpService } from "./service";

export async function handleCustomQuery(job: AcpJob, service: AcpService) {
    const { phase } = job;
    if (phase === AcpJobPhases.REQUEST && memoToSign?.nextPhase === AcpJobPhases.NEGOTIATION) {
        const requirement = job.requirement;
        const canHandle = requirement.type === "custom_query";
        if (canHandle) {
            await job.accept("Custom query handler available");
            await job.createRequirement("Payment required for processing");
        } else {
            await job.reject("This handler only processes custom queries");
        }
        return;
    }
    if (phase === AcpJobPhases.TRANSACTION && memoToSign?.nextPhase === AcpJobPhases.EVALUATION) {
        try {
            const result = await processCustomQuery(job.requirement);
            const deliverable = {
                type: "object",
                value: {
                    result,
                    processedBy: "custom_handler",
                    timestamp: Date.now(),
                },
            };
            await job.deliver(deliverable);
        } catch (error) {
            await job.reject(`Processing failed: ${error.message}`);
        }
    }
}
```
