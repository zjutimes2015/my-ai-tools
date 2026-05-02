import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
  convertToModelMessages,
  createIdGenerator,
  generateId,
  streamText,
  UIMessage,
} from 'ai';

import { findChatById } from '@/shared/models/chat';
import {
  ChatMessageStatus,
  createChatMessage,
  getChatMessages,
  NewChatMessage,
} from '@/shared/models/chat_message';
import { getAllConfigs } from '@/shared/models/config';
import { getUserInfo } from '@/shared/models/user';

export async function POST(req: Request) {
  try {
    const {
      chatId,
      message,
      model,
      webSearch,
      reasoning,
    }: {
      chatId: string;
      message: UIMessage;
      model: string;
      webSearch: boolean;
      reasoning?: boolean;
    } = await req.json();

    if (!chatId || !model) {
      throw new Error('invalid params');
    }

    if (!message || !message.parts || message.parts.length === 0) {
      throw new Error('invalid message');
    }

    // check user sign
    const user = await getUserInfo();
    if (!user) {
      throw new Error('no auth, please sign in');
    }

    // check chat
    const chat = await findChatById(chatId);
    if (!chat) {
      throw new Error('chat not found');
    }

    if (chat.userId !== user?.id) {
      throw new Error('no permission to access this chat');
    }

    const configs = await getAllConfigs();
    
    // Determine provider based on model
    let provider: string;
    let apiKey: string;
    let baseURL: string | undefined;

    if (model.startsWith('deepseek')) {
      provider = 'deepseek';
      apiKey = configs.deepseek_api_key;
      if (!apiKey) {
        throw new Error('deepseek_api_key is not set');
      }
      baseURL = 'https://api.deepseek.com/v1';
    } else {
      provider = 'openrouter';
      apiKey = configs.openrouter_api_key;
      if (!apiKey) {
        throw new Error('openrouter_api_key is not set');
      }
      baseURL = configs.openrouter_base_url;
    }

    const currentTime = new Date();

    const metadata = {
      model,
      webSearch,
      reasoning,
    };

    // save user message to database
    const userMessage: NewChatMessage = {
      id: generateId().toLowerCase(),
      chatId,
      userId: user?.id,
      status: ChatMessageStatus.CREATED,
      createdAt: currentTime,
      updatedAt: currentTime,
      role: 'user',
      parts: JSON.stringify(message.parts),
      metadata: JSON.stringify(metadata),
      model: model,
      provider: provider,
    };
    await createChatMessage(userMessage);

    // load previous messages from database
    const previousMessages = await getChatMessages({
      chatId,
      status: ChatMessageStatus.CREATED,
      page: 1,
      limit: 10,
    });

    let validatedMessages: UIMessage[] = [];
    if (previousMessages.length > 0) {
      validatedMessages = previousMessages.reverse().map((message) => ({
        id: message.id,
        role: message.role,
        parts: message.parts ? JSON.parse(message.parts) : [],
      })) as UIMessage[];
    }

    // Create provider based on model
    let result;
    if (provider === 'deepseek') {
      // DeepSeek API call
      const messages = validatedMessages.map((msg) => ({
        role: msg.role,
        content: (msg.parts || []).map((part: any) => {
          if (typeof part === 'string') return part;
          if (part.type === 'text') return part.content;
          return '';
        }).join('\n'),
      }));

      // Add current user message
      messages.push({
        role: 'user',
        content: (message.parts || []).map((part: any) => {
          if (typeof part === 'string') return part;
          if (part.type === 'text') return part.content;
          return '';
        }).join('\n'),
      });

      const resp = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model,
          messages,
          stream: true,
        }),
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        throw new Error(`DeepSeek request failed: ${errorText}`);
      }

      // Stream response
      const reader = resp.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder('utf-8');
      let fullResponse = '';

      const stream = new ReadableStream({
        async start(controller) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              
              const chunk = decoder.decode(value, { stream: true });
              const lines = chunk.split('\n');
              
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const data = line.slice(6);
                  if (data === '[DONE]') continue;
                  
                  try {
                    const json = JSON.parse(data);
                    const content = json.choices?.[0]?.delta?.content || '';
                    fullResponse += content;
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
                      type: 'content',
                      content,
                    })}\n\n`));
                  } catch (e) {
                    // Ignore parse errors for non-JSON lines
                  }
                }
              }
            }
            
            // Save assistant message
            const assistantMessage: NewChatMessage = {
              id: generateId().toLowerCase(),
              chatId,
              userId: user?.id,
              status: ChatMessageStatus.CREATED,
              createdAt: currentTime,
              updatedAt: currentTime,
              model: model,
              provider: provider,
              parts: JSON.stringify([{ type: 'text', content: fullResponse }]),
              role: 'assistant',
            };
            await createChatMessage(assistantMessage);
            
            controller.close();
          } catch (e: any) {
            controller.error(e);
          }
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    } else {
      // OpenRouter API call
      const openrouter = createOpenRouter({
        apiKey: apiKey,
        baseURL: baseURL ? baseURL : undefined,
      });

      result = streamText({
        model: openrouter.chat(model),
        messages: convertToModelMessages(validatedMessages),
      });

      return result.toUIMessageStreamResponse({
        sendSources: true,
        sendReasoning: Boolean(reasoning),
        originalMessages: validatedMessages,
        generateMessageId: createIdGenerator({
          size: 16,
        }),
        onFinish: async ({ messages }) => {
          const lastMessage = messages[messages.length - 1];
          if (lastMessage.role === 'assistant') {
            const assistantMessage: NewChatMessage = {
              id: generateId().toLowerCase(),
              chatId,
              userId: user?.id,
              status: ChatMessageStatus.CREATED,
              createdAt: currentTime,
              updatedAt: currentTime,
              model: model,
              provider: provider,
              parts: JSON.stringify(lastMessage.parts),
              role: 'assistant',
            };
            await createChatMessage(assistantMessage);
          }
        },
      });
    }
  } catch (e: any) {
    console.log('chat failed:', e);
    return new Response(e.message, { status: 500 });
  }
}
