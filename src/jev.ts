import type {LearningHint} from './production/learning';
import {parseRelationships,relationshipContext,fingerprint} from './relationships';
import {CONFIG} from './config';
import { TypeSafeClient, type Fetch } from '@typesafe-ai/sdk';
import type { MailInput } from './graph';
import { QUESTIONS, parseClassification } from './taxonomy';

export function prepareState(message: MailInput, relationships?:string, learning?:LearningHint) {
  const context=parseRelationships(relationships,Object.keys(CONFIG.types));
  const limitations: string[] = [];
  if (message.bodyText.length > CONFIG.maxBodyCharacters) limitations.push('Message body truncated; human review required.');
  if (message.hasAttachments) limitations.push('Attachments not analyzed; human review required.');
  if (message.to.length > 30 || message.cc.length > 30 || message.subject.length > 500) limitations.push('Message metadata truncated; human review required.');
  return {
    limitations,
    state: {
      ...(learning?{owner_correction_history:learning}:{}),
      reviewer: CONFIG.ownerContext, organization: CONFIG.organizationContext,
      ...(context?{business_context:relationshipContext(message,context)}:{}),
      email: {
        subject: message.subject.slice(0, 500), from: message.from,
        to: message.to.slice(0, 30), cc: message.cc.slice(0, 30),
        received_at: message.receivedAt, body_text: message.bodyText.slice(0, CONFIG.maxBodyCharacters),
        has_attachments: message.hasAttachments,
      },
      context_limits: ['Only this message is supplied; no separate conversation history.', ...limitations],
    },
  };
}

export async function classifyMessage(message: MailInput, apiKey: string, transport?: Fetch, relationships?:string, learning?:LearningHint) {
  const prepared = prepareState(message,relationships,learning);
  const client = new TypeSafeClient({
    apiKey, baseURL: 'https://api.typesafe.ai', defaultModel: CONFIG.model,
    logLevel: 'off', timeout: 20_000, retry: { maxRetries: 0 }, fetch: transport,
  });
  const response = await client.systemOne({ state: prepared.state, questions: QUESTIONS });
  return { classifierContextVersion:relationships?'relationships-v2:'+await fingerprint(JSON.parse(relationships)):'relationships-none', classification: parseClassification(response.answers), model: response.model, limitations: prepared.limitations };
}
