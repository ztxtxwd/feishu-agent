const express = require('express');
const { MultiServerMCPClient } = require('@langchain/mcp-adapters');
const { ChatOpenAI } = require('@langchain/openai');
const { createReactAgent } = require('@langchain/langgraph/prebuilt');
const { OAuthClientProvider } = require('mcp-remote-oauth-client-provider');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// MCP客户端实例
let mcpClient = null;

// React Agent实例
let reactAgent = null;

// ChatOpenAI模型实例
let chatModel = null;

// OAuth认证提供者实例
let authProvider = null;

// 初始化ChatOpenAI模型
function initializeChatModel() {
  try {
    console.log('正在初始化ChatOpenAI模型...');
    
    chatModel = new ChatOpenAI({
      model: "kimi-k2-250711",
      configuration: {
        baseURL: process.env.OPENAI_API_BASE,
        apiKey: process.env.VOLCES_API_KEY,
      },
      verbose: false,
      streaming: false // 启用流式响应
    });
    
    console.log('ChatOpenAI模型初始化成功');
    return chatModel;
  } catch (error) {
    console.error('ChatOpenAI模型初始化失败:', error.message);
    chatModel = null;
    return null;
  }
}

// 初始化MCP客户端和React Agent
async function initializeMCPClient() {
  try {
    console.log('正在初始化MCP客户端...');
    const serverUrl = process.env.MCP_SERVER_URL || 'https://fms.666444.best/sse';
    const callbackPort = parseInt(process.env.MCP_CALLBACK_PORT || '12334');
    
    console.log(`尝试连接到MCP服务器: ${serverUrl}`);
    
    // 创建OAuth认证提供者
    authProvider = OAuthClientProvider.createWithAutoAuth({
      serverUrl,
      callbackPort,
      host: "localhost",
      clientName: 'Feishu Comment Monitor',
    });
    
    mcpClient = new MultiServerMCPClient({
      mcpServers: {
        feishu: {
          url: serverUrl,
          authProvider
        },
      },
      useStandardContentBlocks: true,
    });
    
    // 获取可用工具
    const tools = await mcpClient.getTools();
    console.log('MCP客户端初始化成功');
    console.log('可用工具数量:', tools.length);
    
    // 初始化ChatOpenAI模型
    const model = initializeChatModel();
    
    if (model && tools.length > 0) {
      // 创建React Agent
      console.log('正在初始化React Agent...');
      reactAgent = createReactAgent({
        llm: model,
        tools,
        recursionLimit: 100
      });
      console.log('React Agent初始化成功');
    }
    
    return tools;
  } catch (error) {
    console.error('MCP客户端初始化失败:', error.message);
    console.log('提示: 请确保MCP服务器正在运行并且可以访问');
    console.log('提示: 如果需要认证，请检查认证配置');
    mcpClient = null;
    reactAgent = null;
    return [];
  }
}

// 中间件
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 解析飞书文档URL，提取文档ID
function parseFeishuDocId(url) {
  try {
    // 飞书文档URL格式示例:
    // https://bytedance.feishu.cn/docx/doxcnxxxxxxxxxxxxxx
    // https://bytedance.feishu.cn/docs/doccnxxxxxxxxxxxxxx
    // https://bytedance.feishu.cn/wiki/wikcnxxxxxxxxxxxxxx
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    
    // 匹配不同类型的文档ID
    const docIdMatch = pathname.match(/\/(docx|docs|wiki)\/([a-zA-Z0-9]+)/);
    if (docIdMatch) {
      return {
        type: docIdMatch[1],
        id: docIdMatch[2],
        fullId: docIdMatch[2]
      };
    }
    
    return null;
  } catch (error) {
    console.error('URL解析错误:', error.message);
    return null;
  }
}

// 存储活跃的定时器
const activeTimers = new Map();

// 存储每个文档的评论缓存，用于检测新增评论
const commentsCache = new Map();

// 调用获取全文评论工具并监控新增评论
async function invokeGetCommentsTools(docId) {
  if (!mcpClient) {
    console.error('MCP客户端未初始化，无法调用工具');
    return null;
  }
  
  try {
    // 获取可用工具
    const tools = await mcpClient.getTools();
    
    // 查找获取全文评论相关的工具
    const commentTool = tools.find(tool => 
      tool.name === 'drive_comment_list'
    );
    
    if (!commentTool) {
      console.log('未找到获取全文评论工具');
      return null;
    }
    
    // 根据@langchain/mcp-adapters文档，使用invoke方法调用工具
    const result = await commentTool.invoke({
        file_token: docId,
        file_type: 'docx', // 默认使用新版文档类型
        is_whole: true,    // 获取全文评论
        is_solved: false   // 获取所有评论（包括未解决的）
      });
      
      // 解析响应数据
      const responseData = JSON.parse(result);
      const currentComments = responseData.items || [];
      
      // 获取之前缓存的评论
      const cachedComments = commentsCache.get(docId) || [];
      
      // 检测新增评论
      const newComments = detectNewComments(cachedComments, currentComments);
      
      // 立即更新缓存，避免重复识别
      commentsCache.set(docId, currentComments);
      
      // 如果有新增评论，输出提醒并使用Agent分析
       if (newComments.length > 0) {
         console.log(`\n🔔 检测到 ${newComments.length} 条新增评论:`);
         
         for (let index = 0; index < newComments.length; index++) {
           const comment = newComments[index];
           const commentText = comment.reply_list?.replies?.[0]?.content?.elements?.[0]?.text_run?.text || '无法获取评论内容';
           const author = comment.reply_list?.replies?.[0]?.user_name || '未知用户';
           const createTime = comment.reply_list?.replies?.[0]?.create_time || '未知时间';
           
           console.log(`  ${index + 1}. [${author}] ${new Date(parseInt(createTime) * 1000).toLocaleString()}: ${commentText}`);
           
           // 使用React Agent分析每条新增评论（异步处理，不影响缓存更新）
           try {
             await processNewCommentWithAgent(comment, docId);
           } catch (error) {
             console.error(`处理评论时出错: ${error.message}`);
           }
         }
         
         console.log('=' .repeat(80));
       }
      
      return result;
  } catch (error) {
    console.error('调用获取全文评论工具失败:', error.message);
    // 如果是ToolException，提供更详细的错误信息
    if (error.name === 'ToolException') {
      console.error('工具执行失败:', error.message);
    }
    return null;
  }
}

// 使用React Agent处理新增评论（支持流式响应）
async function processNewCommentWithAgent(comment, docId) {
  if (!reactAgent) {
    console.log('⚠️ React Agent未初始化，跳过智能处理');
    return null;
  }
  
  try {
    const commentText = comment.reply_list?.replies?.[0]?.content?.elements?.[0]?.text_run?.text || '无法获取评论内容';
    const author = comment.reply_list?.replies?.[0]?.user_name || '未知用户';
    
    console.log(`🤖 正在执行用户指令: "${commentText} ${docId}"`);
    
    // 构造给Agent的输入
    const agentInput = `按照以下要求修改这个文档（文档ID:${docId})：${commentText}`;
    
    // 使用流式响应
    const stream = await reactAgent.stream({
      messages: [{ role: "user", content: agentInput }]
    },{ recursionLimit: 100 });
    
    console.log('🎯 Agent处理中...');
    let finalResponse = null;
    
    for await (const chunk of stream) {
      // console.log("chunk===========\n",JSON.stringify(chunk))
      // Print each step of the agent's execution
      if (chunk.agent) {
        const agentMessage = chunk.agent.messages[chunk.agent.messages.length - 1];
        
        // Print token usage for this chunk if available
        if (agentMessage.usage_metadata) {
          console.log('\n📊 Token Usage:');
          console.log(`   Input tokens: ${agentMessage.usage_metadata.input_tokens}`);
          console.log(`   Output tokens: ${agentMessage.usage_metadata.output_tokens}`);
          console.log(`   Total tokens: ${agentMessage.usage_metadata.total_tokens}`);
        } else if (agentMessage.response_metadata?.tokenUsage) {
          console.log('\n📊 Token Usage:');
          console.log(`   Input tokens: ${agentMessage.response_metadata.tokenUsage.promptTokens}`);
          console.log(`   Output tokens: ${agentMessage.response_metadata.tokenUsage.completionTokens}`);
          console.log(`   Total tokens: ${agentMessage.response_metadata.tokenUsage.totalTokens}`);
        }
        
        if (agentMessage.content) {
          console.log('\n🤖 Agent:', agentMessage.content);
        }
        if (agentMessage.reasoning_content) {
          console.log('\n🤖 Agent is thinking:', agentMessage.reasoning_content);
        }
        
        // Check if agent is making tool calls
        if (agentMessage.additional_kwargs?.tool_calls) {
          console.log('\n📞 Agent is calling tools:');
          for (const toolCall of agentMessage.additional_kwargs.tool_calls) {
            console.log(`   - Tool: ${toolCall.function.name}`);
            // console.log(`     Arguments:`, JSON.parse(toolCall.function.arguments));
          }
        }
      }
      
      if (chunk.tools) {
        for (const [key, toolMessages] of Object.entries(chunk.tools)) {
          if (Array.isArray(toolMessages)) {
            for (const message of toolMessages) {
              // Handle tool call messages
              if (message.kwargs?.tool_call_id) {
                const toolCallId = message.kwargs.tool_call_id;
                const toolName = toolCallId.split(':')[0]; // Extract tool name from tool_call_id
                console.log(`\n🔧 Tool called: ${toolName}`);
                console.log(`   Tool Call ID: ${toolCallId}`);
                
                // Parse and display the tool response
                try {
                  const content = JSON.parse(message.kwargs.content);
                  if (content.code === 0 && content.data) {
                    console.log('   ✅ Tool Response:');
                    console.log(`      Status: Success`);
                    console.log(`      Data:`, JSON.stringify(content.data, null, 6));
                  } else {
                    console.log('   ❌ Tool Response:');
                    console.log(`      Error: ${content.msg || 'Unknown error'}`);
                  }
                } catch (e) {
                  // If content is not JSON, display as is
                  console.log('   Tool Response:', message.kwargs.content);
                }
              }
            }
          }
        }
      }
      
      if (chunk.__end__) {
        finalResponse = chunk;
      }
    }
    
    if (finalResponse && finalResponse.messages) {
      const lastMessage = finalResponse.messages[finalResponse.messages.length - 1];
      console.log('\n📝 处理完成:');
      console.log(lastMessage.content);
    }
    
    console.log('');
    return finalResponse;
  } catch (error) {
    console.error('❌ React Agent处理评论失败:', error.message);
    return null;
  }
}

// 检测新增评论的函数
function detectNewComments(cachedComments, currentComments) {
  // 如果是第一次获取评论，不算作新增
  if (cachedComments.length === 0) {
    console.log(`📋 初始化监控，当前共有 ${currentComments.length} 条评论`);
    return [];
  }
  
  // 创建缓存评论的ID集合，用于快速查找
  const cachedCommentIds = new Set();
  cachedComments.forEach(comment => {
    if (comment.reply_list && comment.reply_list.replies) {
      comment.reply_list.replies.forEach(reply => {
        if (reply.reply_id) {
          cachedCommentIds.add(reply.reply_id);
        }
      });
    }
  });
  
  // 找出新增的评论
  const newComments = [];
  currentComments.forEach(comment => {
    if (comment.reply_list && comment.reply_list.replies) {
      comment.reply_list.replies.forEach(reply => {
        if (reply.reply_id && !cachedCommentIds.has(reply.reply_id)) {
          // 构造新评论对象，保持与原始数据结构一致
          newComments.push({
            ...comment,
            reply_list: {
              ...comment.reply_list,
              replies: [reply] // 只包含新增的回复
            }
          });
        }
      });
    }
  });
  
  return newComments;
}

// 基本路由
app.get('/', (req, res) => {
  const { url } = req.query;
  
  if (url) {
    console.log('收到飞书文档URL:', url);
    
    // 解析文档ID
    const docInfo = parseFeishuDocId(url);
    
    if (docInfo) {
      console.log('文档类型:', docInfo.type);
      console.log('文档ID:', docInfo.id);
      console.log('完整文档ID:', docInfo.fullId);
      
      // 停止之前的定时器（如果存在）
      if (activeTimers.has(docInfo.fullId)) {
        clearInterval(activeTimers.get(docInfo.fullId));
        // 清理对应的评论缓存，重新开始监控
        commentsCache.delete(docInfo.fullId);
      }
      
      // 启动新的定时任务，每秒调用一次获取全文评论工具
      const timer = setInterval(async () => {
        await invokeGetCommentsTools(docInfo.fullId);
      }, 1000); // 每秒执行一次
      
      // 存储定时器
      activeTimers.set(docInfo.fullId, timer);
      
    } else {
      console.log('无法解析文档ID，URL格式可能不正确');
    }
    
    // 返回302重定向到指定的URL
    console.log('重定向到:', url);
    res.redirect(302, url);
  } else {
    // 处理不带url参数的请求
    res.json({
      message: '飞书文档评论监控服务',
      status: 'running',
      activeMonitors: activeTimers.size,
      timestamp: new Date().toISOString()
    });
  }
});

// 健康检查接口
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// 评论监控相关接口
app.get('/api/comments', (req, res) => {
  res.json({
    message: '获取评论列表',
    data: [],
    timestamp: new Date().toISOString()
  });
});

app.post('/api/comments/webhook', (req, res) => {
  console.log('收到评论webhook:', req.body);
  res.json({
    message: '评论webhook接收成功',
    received: true,
    timestamp: new Date().toISOString()
  });
});

// 获取活跃的监控任务
app.get('/api/monitors', (req, res) => {
  const monitors = Array.from(activeTimers.keys()).map(docId => ({
    documentId: docId,
    startTime: new Date().toISOString(), // 简化处理，实际应该记录启动时间
    status: 'running'
  }));
  
  res.json({
    message: '获取监控任务列表成功',
    monitors: monitors,
    count: monitors.length,
    timestamp: new Date().toISOString()
  });
});

// 停止指定文档的监控任务
app.delete('/api/monitors/:docId', (req, res) => {
  const { docId } = req.params;
  
  if (activeTimers.has(docId)) {
    clearInterval(activeTimers.get(docId));
    activeTimers.delete(docId);
    
    // 清理对应的评论缓存
    commentsCache.delete(docId);
    
    res.json({
      message: '监控任务停止成功',
      documentId: docId,
      timestamp: new Date().toISOString()
    });
  } else {
    res.status(404).json({
      error: '监控任务不存在',
      documentId: docId,
      timestamp: new Date().toISOString()
    });
  }
});

// 停止所有监控任务
app.delete('/api/monitors', (req, res) => {
  const stoppedCount = activeTimers.size;
  
  activeTimers.forEach((timer, docId) => {
    clearInterval(timer);
  });
  
  activeTimers.clear();
  
  // 清理所有评论缓存
  commentsCache.clear();
  
  res.json({
    message: '所有监控任务已停止',
    stoppedCount: stoppedCount,
    timestamp: new Date().toISOString()
  });
});

// MCP工具相关接口
app.get('/api/mcp/tools', async (req, res) => {
  try {
    if (!mcpClient) {
      return res.status(503).json({
        error: 'MCP客户端未初始化',
        timestamp: new Date().toISOString()
      });
    }
    
    const tools = await mcpClient.getTools();
    res.json({
      message: '获取MCP工具列表成功',
      tools: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema || tool.schema || {},
        schema: tool.schema
      })),
      count: tools.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('获取MCP工具失败:', error);
    res.status(500).json({
      error: '获取MCP工具失败',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// 使用Agent执行任务的API
app.post('/api/agent/execute', express.json(), async (req, res) => {
  try {
    if (!reactAgent) {
      return res.status(503).json({
        error: 'React Agent未初始化',
        timestamp: new Date().toISOString()
      });
    }
    
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({
        error: '请提供消息内容',
        timestamp: new Date().toISOString()
      });
    }
    
    console.log('📨 收到Agent执行请求:', message);
    
    // 设置SSE响应头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    
    try {
      const stream = await reactAgent.stream({
        messages: [{ role: "user", content: message }]
      });
      
      for await (const chunk of stream) {
        // 发送Agent消息
        if (chunk.agent) {
          const agentMessage = chunk.agent.messages[chunk.agent.messages.length - 1];
          
          if (agentMessage.content) {
            res.write(`data: ${JSON.stringify({ type: 'agent', content: agentMessage.content })}\n\n`);
          }
          
          if (agentMessage.additional_kwargs?.tool_calls) {
            for (const toolCall of agentMessage.additional_kwargs.tool_calls) {
              res.write(`data: ${JSON.stringify({ 
                type: 'tool_call', 
                tool: toolCall.function.name,
                args: JSON.parse(toolCall.function.arguments)
              })}\n\n`);
            }
          }
        }
        
        // 发送工具响应
        if (chunk.tools) {
          for (const [key, toolMessages] of Object.entries(chunk.tools)) {
            if (Array.isArray(toolMessages)) {
              for (const message of toolMessages) {
                if (message.kwargs?.tool_call_id) {
                  const toolName = message.kwargs.tool_call_id.split(':')[0];
                  res.write(`data: ${JSON.stringify({ 
                    type: 'tool_response', 
                    tool: toolName,
                    success: true
                  })}\n\n`);
                }
              }
            }
          }
        }
        
        // 发送最终响应
        if (chunk.__end__ && chunk.messages) {
          const lastMessage = chunk.messages[chunk.messages.length - 1];
          res.write(`data: ${JSON.stringify({ 
            type: 'final', 
            content: lastMessage.content 
          })}\n\n`);
        }
      }
      
      res.write('data: [DONE]\n\n');
      res.end();
      
    } catch (streamError) {
      console.error('Stream处理错误:', streamError);
      res.write(`data: ${JSON.stringify({ 
        type: 'error', 
        message: streamError.message 
      })}\n\n`);
      res.end();
    }
    
  } catch (error) {
    console.error('Agent执行失败:', error);
    res.status(500).json({
      error: 'Agent执行失败',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/api/mcp/status', (req, res) => {
  res.json({
    message: 'MCP客户端状态',
    connected: mcpClient !== null,
    serverUrl: 'https://fms.666444.best/mcp',
    timestamp: new Date().toISOString()
  });
});

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: '服务器内部错误',
    message: err.message
  });
});

// 404处理
app.use('*', (req, res) => {
  res.status(404).json({
    error: '接口不存在',
    path: req.originalUrl
  });
});

// 启动服务器
app.listen(PORT, async () => {
  console.log(`飞书文档评论监控服务已启动 (使用nodemon自动重启)`);
  console.log(`服务地址: http://localhost:${PORT}`);
  console.log(`健康检查: http://localhost:${PORT}/health`);
  console.log(`评论API: http://localhost:${PORT}/api/comments`);
  console.log(`监控任务: http://localhost:${PORT}/api/monitors`);
  console.log(`MCP工具: http://localhost:${PORT}/api/mcp/tools`);
  console.log(`MCP状态: http://localhost:${PORT}/api/mcp/status`);
  console.log(`Agent执行: POST http://localhost:${PORT}/api/agent/execute`);
  console.log(`使用方法: 访问 /?url=飞书文档链接 开始监控`);
  
  // 初始化MCP客户端
  await initializeMCPClient();
});

// 优雅关闭处理
process.on('SIGINT', async () => {
  console.log('\n正在关闭服务器...');
  
  // 清理所有定时器和缓存
  if (activeTimers.size > 0) {
    activeTimers.forEach((timer, docId) => {
      clearInterval(timer);
    });
    activeTimers.clear();
  }
  
  // 清理评论缓存
  commentsCache.clear();
  
  // 清理OAuth认证提供者
  if (authProvider) {
    try {
      await authProvider.cleanup();
      console.log('OAuth认证已清理');
    } catch (error) {
      console.error('清理OAuth认证时出错:', error.message);
    }
  }
  
  if (mcpClient) {
    try {
      console.log('正在关闭MCP客户端连接...');
      await mcpClient.close();
      console.log('MCP客户端连接已关闭');
    } catch (error) {
      console.error('关闭MCP客户端时出错:', error.message);
    }
  }
  
  console.log('服务器已关闭');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n收到SIGTERM信号，正在关闭服务器...');
  
  // 清理所有定时器和缓存
  if (activeTimers.size > 0) {
    activeTimers.forEach((timer, docId) => {
      clearInterval(timer);
    });
    activeTimers.clear();
  }
  
  // 清理评论缓存
  commentsCache.clear();
  
  // 清理OAuth认证提供者
  if (authProvider) {
    try {
      await authProvider.cleanup();
    } catch (error) {
      console.error('清理OAuth认证时出错:', error.message);
    }
  }
  
  if (mcpClient) {
    try {
      await mcpClient.close();
      console.log('MCP客户端连接已关闭');
    } catch (error) {
      console.error('关闭MCP客户端时出错:', error.message);
    }
  }
  
  process.exit(0);
});

module.exports = app;