import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { OAuthClientProvider } from './mcp-remote-oauth-client-provider/dist/index.js'

import dotenv from 'dotenv';
dotenv.config();

// Initialize the ChatOpenAI model
const model = new ChatOpenAI({
  model: "google-claude-sonnet-4",
  configuration: {
    baseURL: process.env.OPENAI_API_BASE,
    apiKey: process.env.VOLCES_API_KEY
  },
  verbose: false,
  streaming: true // Enable streaming for better response flow
});

// MCP Server configuration
const serverUrl = "https://fms.666444.best/mcp"
const callbackPort = 12334

// Create OAuth provider with automatic authentication
const authProvider = OAuthClientProvider.createWithAutoAuth({
  serverUrl,
  callbackPort,
  host: "localhost",
  clientName: 'MCP Agent Client',
})

// Initialize MCP client with remote server
const client = new MultiServerMCPClient({
  mcpServers: {
    feishu: {
      url: serverUrl,
      authProvider
    },
  },
  useStandardContentBlocks: true,
});

async function runAgent() {
  try {
    // Initialize and get tools from the MCP server
    console.log('🔄 Initializing MCP client...')
    const tools = await client.getTools();
    console.log(`✅ Successfully retrieved ${tools.length} tools from server`)
    
    // Display available tools
    if (tools.length > 0) {
      console.log('\n📋 Available tools:')
      tools.forEach((tool, index) => {
        console.log(`  ${index + 1}. ${tool.name} - ${tool.description}`)
      })
    }

    // Create the React agent with the tools
    const agent = createReactAgent({
      llm: model,
      tools
    });

    // Example: Run the agent with a task
    console.log('\n🚀 Starting agent execution...\n');
    
    const stream = await agent.stream({
      messages: [{ 
        role: "user", 
        content: "获取飞书文档列表并展示前3个文档的标题" // Example task
      }],
    });
    
    // Process the stream
    for await (const chunk of stream) {
      // Handle agent messages
      if (chunk.agent) {
        const agentMessage = chunk.agent.messages[chunk.agent.messages.length - 1];
        
        // Display token usage if available
        if (agentMessage.usage_metadata) {
          console.log('\n📊 Token Usage:');
          console.log(`   Input: ${agentMessage.usage_metadata.input_tokens}`);
          console.log(`   Output: ${agentMessage.usage_metadata.output_tokens}`);
          console.log(`   Total: ${agentMessage.usage_metadata.total_tokens}`);
        }
        
        // Display agent's response
        if (agentMessage.content) {
          console.log('\n🤖 Agent:', agentMessage.content);
        }
        
        // Display agent's reasoning (if available)
        if (agentMessage.reasoning_content) {
          console.log('\n💭 Reasoning:', agentMessage.reasoning_content);
        }
        
        // Display tool calls
        if (agentMessage.additional_kwargs?.tool_calls) {
          console.log('\n🔧 Calling tools:');
          for (const toolCall of agentMessage.additional_kwargs.tool_calls) {
            console.log(`   - ${toolCall.function.name}`);
            const args = JSON.parse(toolCall.function.arguments);
            console.log(`     Args:`, args);
          }
        }
      }
      
      // Handle tool responses
      if (chunk.tools) {
        for (const [key, toolMessages] of Object.entries(chunk.tools)) {
          if (Array.isArray(toolMessages)) {
            for (const message of toolMessages) {
              if (message.kwargs?.tool_call_id) {
                const toolName = message.kwargs.tool_call_id.split(':')[0];
                console.log(`\n✨ Tool Response from ${toolName}:`);
                
                try {
                  const content = JSON.parse(message.kwargs.content);
                  if (content.code === 0) {
                    console.log('   ✅ Success');
                    if (content.data) {
                      console.log('   Data:', JSON.stringify(content.data, null, 2));
                    }
                  } else {
                    console.log('   ❌ Error:', content.msg || 'Unknown error');
                  }
                } catch (e) {
                  console.log('   Response:', message.kwargs.content);
                }
              }
            }
          }
        }
      }
      
      // Handle end of stream
      if (chunk.__end__) {
        console.log('\n✅ Agent execution completed');
        
        // Display final response
        if (chunk.messages) {
          const lastMessage = chunk.messages[chunk.messages.length - 1];
          console.log('\n📝 Final Answer:');
          console.log('═'.repeat(50));
          console.log(lastMessage.content);
          console.log('═'.repeat(50));
        }
      }
    }
    
  } catch (error) {
    console.error("❌ Error during agent execution:", error);
    if (error.name === "ToolException") {
      console.error("Tool execution failed:", error.message);
    }
  } finally {
    // Clean up resources
    try {
      await authProvider.cleanup()
      console.log('\n🧹 Cleanup completed successfully')
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError)
    }
  }
}

// Run the agent
runAgent();