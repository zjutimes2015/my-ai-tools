import { nanoid } from 'nanoid';

import {
  AIConfigs,
  AIGenerateParams,
  AIMediaType,
  AIProvider,
  AITaskResult,
  AITaskStatus,
} from './types';

/**
 * DeepSeek configs
 */
export interface DeepSeekConfigs extends AIConfigs {
  apiKey: string;
}

/**
 * DeepSeek provider for text generation
 */
export class DeepSeekProvider implements AIProvider {
  // provider name
  readonly name = 'deepseek';
  // provider configs
  configs: DeepSeekConfigs;

  // init provider
  constructor(configs: DeepSeekConfigs) {
    this.configs = configs;
  }

  // generate task
  async generate({
    params,
  }: {
    params: AIGenerateParams;
  }): Promise<AITaskResult> {
    const { mediaType, model, prompt, stream, options } = params;

    if (mediaType !== AIMediaType.TEXT) {
      throw new Error(`mediaType not supported: ${mediaType}`);
    }

    if (!prompt) {
      throw new Error('prompt is required');
    }

    const modelName = model || 'deepseek-chat';
    const apiUrl = 'https://api.deepseek.com/v1/chat/completions';

    const messages = [
      {
        role: 'user',
        content: prompt,
      },
    ];

    const payload = {
      model: modelName,
      messages,
      stream: stream || false,
      temperature: options?.temperature || 0.7,
      max_tokens: options?.max_tokens || 2048,
      ...(options || {}),
    };

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.configs.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(
        `DeepSeek request failed with status: ${resp.status}, body: ${errorText}`
      );
    }

    const taskId = nanoid();
    const data = await resp.json();

    return {
      taskStatus: AITaskStatus.SUCCESS,
      taskId,
      taskInfo: {
        status: 'success',
        createTime: new Date(),
      },
      taskResult: data,
    };
  }
}